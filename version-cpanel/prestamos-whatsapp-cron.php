<?php
declare(strict_types=1);

// Subir este archivo al directorio principal de cPanel, junto a prestamos-config.php.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
date_default_timezone_set('America/Lima');

$configPath = __DIR__.'/prestamos-config.php';
if (!is_readable($configPath)) { fwrite(STDERR, "Falta prestamos-config.php\n"); exit(1); }
$config = require $configPath;
if (empty($config['whatsapp_auto_enabled'])) exit(0);
$apiKey = $config['wasender_api_key'] ?? '';
if (!is_string($apiKey) || $apiKey === '' || str_starts_with($apiKey, 'REEMPLAZAR')) {
    fwrite(STDERR, "Configura wasender_api_key en el archivo privado.\n");
    exit(1);
}
if (!function_exists('curl_init')) { fwrite(STDERR, "Falta la extensión PHP cURL.\n"); exit(1); }

function validPhone(string $value): ?string {
    $digits = preg_replace('/\D+/', '', $value);
    if (preg_match('/^9\d{8}$/', $digits)) return '+51'.$digits;
    if (preg_match('/^519\d{8}$/', $digits)) return '+'.$digits;
    return null;
}

function dueDate(string $first, string $frequency, int $index): string {
    $date = new DateTimeImmutable($first, new DateTimeZone('UTC'));
    if ($frequency === 'week') return $date->modify('+'.($index * 7).' days')->format('Y-m-d');
    if ($frequency === 'fortnight') return $date->modify('+'.($index * 15).' days')->format('Y-m-d');
    $day = (int) $date->format('j');
    $month = $date->modify('first day of this month')->modify('+'.$index.' months');
    return $month->setDate((int) $month->format('Y'), (int) $month->format('n'),
        min($day, (int) $month->format('t')))->format('Y-m-d');
}

function installments(object $loan): array {
    $paid = 0;
    foreach ($loan->payments ?? [] as $payment) $paid += (int) ($payment->amount ?? 0);
    $rows = [];
    for ($i = 0; $i < (int) ($loan->count ?? 0) && $i < 120; $i++) {
        $amount = (int) ($loan->amount ?? 0);
        $rows[$i] = ['date'=>dueDate((string) $loan->first, (string) $loan->frequency, $i),
            'left'=>max($amount - $paid, 0)];
        $paid = max($paid - $amount, 0);
    }
    return $rows;
}

function money(int $cents): string { return 'S/ '.number_format($cents / 100, 2, '.', ','); }

function finish(PDO $db, int $id, string $status, ?string $phone, ?string $message, ?string $error): void {
    $db->prepare("UPDATE whatsapp_outbox SET status=?, recipient=?, message_text=?, last_error=?,
        accepted_at=IF(?='accepted', NOW(), accepted_at), claimed_at=NULL WHERE id=?")
        ->execute([$status, $phone, $message, $error, $status, $id]);
}

try {
    $db = new PDO('mysql:host='.$config['host'].';dbname='.$config['database'].';charset=utf8mb4',
        $config['user'], $config['password'],
        [PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION, PDO::ATTR_EMULATE_PREPARES=>false]);
    $lockName = 'prestamos_wa_'.substr(hash('sha256', $config['database']), 0, 20);
    if ((int) $db->query('SELECT GET_LOCK('.$db->quote($lockName).', 0)')->fetchColumn() !== 1) exit(0);
    try {
        $db->exec("UPDATE whatsapp_outbox SET status='unknown', last_error='Proceso interrumpido; revisar antes de reenviar',
            claimed_at=NULL WHERE status='sending' AND claimed_at < NOW() - INTERVAL 10 MINUTE");
        $raw = $db->query('SELECT datos FROM registro WHERE id=1')->fetchColumn();
        if (!is_string($raw)) throw new RuntimeException('Registro ausente');
        $data = json_decode($raw, false, 512, JSON_THROW_ON_ERROR);
        $loans = [];
        foreach ($data->loans ?? [] as $loan) {
            if (is_string($loan->id ?? null)) $loans[$loan->id] = $loan;
        }
        $friends = [];
        foreach ($data->friends ?? [] as $friend) {
            if (is_string($friend->person ?? null)) $friends[$friend->person] = $friend;
        }
        $now = new DateTimeImmutable('now', new DateTimeZone('America/Lima'));
        $today = $now->format('Y-m-d');
        $hour = (int) $now->format('G');
        if ($hour >= 9 && $hour < 20) {
            $enqueue = $db->prepare("INSERT IGNORE INTO whatsapp_outbox
                (message_key, kind, loan_id, installment_index, due_date)
                VALUES (?, 'due', ?, ?, ?)");
            foreach ($loans as $loan) {
                $friend = $friends[$loan->person ?? ''] ?? null;
                if (($friend->whatsappConsent ?? false) !== true
                    || !validPhone((string) ($friend->phone ?? ''))) continue;
                foreach (installments($loan) as $index=>$part) {
                    if ($part['date'] === $today && $part['left'] > 0) {
                        $key = hash('sha256', 'due:'.$loan->id.':'.$index.':'.$today);
                        $enqueue->execute([$key, $loan->id, $index, $today]);
                    }
                }
            }
        }
        $db->beginTransaction();
        $job = $db->query("SELECT * FROM whatsapp_outbox WHERE status='pending'
            AND next_attempt_at <= NOW() ORDER BY id LIMIT 1 FOR UPDATE")->fetch(PDO::FETCH_ASSOC);
        if (!$job) { $db->commit(); exit(0); }
        $db->prepare("UPDATE whatsapp_outbox SET status='sending', attempts=attempts+1,
            claimed_at=NOW() WHERE id=?")->execute([$job['id']]);
        $db->commit();

        if ($job['kind'] === 'access') {
            $dni = str_starts_with($job['loan_id'], 'client:') ? substr($job['loan_id'], 7) : '';
            $friend = null;
            foreach ($data->friends ?? [] as $candidate) {
                if (($candidate->dni ?? '') === $dni) { $friend = $candidate; break; }
            }
            $phone = $friend ? validPhone((string) ($friend->phone ?? '')) : null;
            $account = $db->prepare('SELECT nombre_cliente FROM cliente_accesos WHERE dni=?');
            $account->execute([$dni]);
            if (!preg_match('/^\d{8}$/D', $dni) || !$friend || !$phone
                || ($friend->whatsappConsent ?? false) !== true
                || $account->fetchColumn() !== ($friend->person ?? null)) {
                finish($db, (int) $job['id'], 'skipped', null, null, 'Acceso, permiso o teléfono no disponible');
                exit(0);
            }
            $secret = $friend->accessSecret ?? null;
            $raw = is_string($secret) && str_starts_with($secret, 'v1:')
                ? base64_decode(substr($secret, 3), true) : false;
            if (!is_string($raw) || strlen($raw) < 29) {
                finish($db, (int) $job['id'], 'failed', null, null, 'Clave de acceso no disponible');
                exit(1);
            }
            $key = hash_hkdf('sha256', (string) $config['password'], 32, 'prestamos-client-access-v1');
            $passwordClient = openssl_decrypt(substr($raw, 28), 'aes-256-gcm', $key,
                OPENSSL_RAW_DATA, substr($raw, 0, 12), substr($raw, 12, 16));
            if (!is_string($passwordClient) || $passwordClient === '') {
                finish($db, (int) $job['id'], 'failed', null, null, 'No se pudo leer la clave de acceso');
                exit(1);
            }
            $person = trim(preg_replace('/[\r\n]+/', ' ', (string) $friend->person));
            $message = 'Hola '.$person.', ya puedes consultar tus préstamos.'
                ."\nUsuario (DNI): ".$dni
                ."\nClave de acceso: ".$passwordClient
                ."\nIngresa aquí: https://prestamos.dadtvplay.com/cliente.php";
        } else {
            $loan = $loans[$job['loan_id']] ?? null;
            $friend = $loan ? ($friends[$loan->person ?? ''] ?? null) : null;
            $phone = $friend ? validPhone((string) ($friend->phone ?? '')) : null;
            if (!$loan || ($friend->whatsappConsent ?? false) !== true || !$phone) {
                finish($db, (int) $job['id'], 'skipped', null, null, 'Préstamo, permiso o teléfono no disponible');
                exit(0);
            }
            $person = trim((string) $loan->person);
            if ($job['kind'] === 'created') {
                $name = trim(str_replace('*', '', preg_replace('/[\r\n]+/', ' ', $person)));
                $principal = ($loan->type ?? '') === 'old' && is_int($loan->originalPrincipal ?? null)
                    ? $loan->originalPrincipal : (int) ($loan->principal ?? 0);
                $message = 'Hola *'.$name."*:\n"
                    .'Registramos tu préstamo de '.money($principal).' con '.(int) $loan->count
                    .' cuota(s) de '.money((int) $loan->amount).".\n"
                    .'La primera vence el '.date('d/m/Y', strtotime((string) $loan->first)).'. Gracias.';
            } elseif ($job['kind'] === 'due') {
                if ($hour < 9 || $hour >= 20) {
                    finish($db, (int) $job['id'], 'skipped', null, null, 'Fuera del horario de recordatorios');
                    exit(0);
                }
                $index = (int) $job['installment_index'];
                $part = installments($loan)[$index] ?? null;
                if (!$part || $part['date'] !== $today || $part['left'] <= 0) {
                    finish($db, (int) $job['id'], 'skipped', null, null, 'La cuota ya no está pendiente hoy');
                    exit(0);
                }
                $message = 'Hola '.$person.', hoy vence tu cuota. Saldo pendiente: '
                    .money($part['left']).'. Gracias.';
            } elseif ($job['kind'] === 'payment') {
                $message = trim((string) ($job['message_text'] ?? ''));
                if ($message === '') {
                    finish($db, (int) $job['id'], 'failed', null, null, 'Comprobante de abono vacío');
                    exit(1);
                }
            } else {
                finish($db, (int) $job['id'], 'failed', null, null, 'Tipo de aviso inválido');
                exit(1);
            }
        }

        $handle = curl_init('https://www.wasenderapi.com/api/send-message');
        curl_setopt_array($handle, [
            CURLOPT_POST=>true,
            CURLOPT_HTTPHEADER=>['Authorization: Bearer '.$apiKey, 'Content-Type: application/json'],
            CURLOPT_POSTFIELDS=>json_encode(['to'=>$phone, 'text'=>$message], JSON_THROW_ON_ERROR),
            CURLOPT_RETURNTRANSFER=>true,
            CURLOPT_CONNECTTIMEOUT=>5,
            CURLOPT_TIMEOUT=>20,
        ]);
        $response = curl_exec($handle);
        $http = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
        curl_close($handle);
        if ($response === false || $http === 0) {
            finish($db, (int) $job['id'], 'unknown', $phone,
                $job['kind'] === 'access' ? null : $message, 'Sin respuesta del proveedor; revisar antes de reenviar');
            exit(1);
        }
        $result = json_decode($response, true);
        if ($http >= 200 && $http < 300 && ($result['success'] ?? false) === true) {
            finish($db, (int) $job['id'], 'accepted', $phone, $job['kind'] === 'access' ? null : $message, null);
            exit(0);
        }
        if ($http === 429) {
            $retry = max(60, min(600, (int) ($result['retry_after'] ?? 60)));
            $db->prepare("UPDATE whatsapp_outbox SET status='pending', claimed_at=NULL,
                next_attempt_at=DATE_ADD(NOW(), INTERVAL ? SECOND), last_error='Límite temporal del proveedor' WHERE id=?")
                ->execute([$retry, $job['id']]);
            exit(0);
        }
        finish($db, (int) $job['id'], $http >= 500 ? 'unknown' : 'failed', $phone,
            $job['kind'] === 'access' ? null : $message,
            'Proveedor HTTP '.$http);
        exit(1);
    } finally {
        $db->query('SELECT RELEASE_LOCK('.$db->quote($lockName).')');
    }
} catch (Throwable $error) {
    if (isset($db) && $db->inTransaction()) $db->rollBack();
    error_log('Mis préstamos WhatsApp: '.get_class($error).' '.$error->getMessage());
    exit(1);
}
