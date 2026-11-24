<?php
declare(strict_types=1);

header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('Content-Type: application/json; charset=utf-8');
if (empty($_SERVER['HTTPS']) || $_SERVER['HTTPS'] === 'off') {
    http_response_code(403);
    exit;
}
$path = dirname(__DIR__, 2).'/prestamos-config.php';
$config = is_readable($path) ? require $path : [];
$user = $config['login_user'] ?? '';
$password = $config['login_password'] ?? '';
if (!is_string($user) || !is_string($password) || strlen($password) < 12) {
    http_response_code(503);
    exit;
}
session_name('prestamos_session');
ini_set('session.use_strict_mode', '1');
session_set_cookie_params(['secure'=>true,'httponly'=>true,'samesite'=>'Strict']);
session_start();
$version = hash('sha256', $user."\0".$password);
if (!isset($_SESSION['auth'], $_SESSION['seen'])
    || !hash_equals($_SESSION['auth'], $version) || time()-$_SESSION['seen'] >= 28800) {
    http_response_code(401);
    exit;
}
$_SESSION['seen'] = time();
$token = $_SESSION['token'] ?? '';
session_write_close();
try {
    $db = new PDO('mysql:host='.$config['host'].';dbname='.$config['database'].';charset=utf8mb4',
        $config['user'], $config['password'],
        [PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION, PDO::ATTR_EMULATE_PREPARES=>false]);
    $action = $_GET['action'] ?? '';
    if ($action === 'image' && $_SERVER['REQUEST_METHOD'] === 'GET') {
        $id = filter_input(INPUT_GET, 'id', FILTER_VALIDATE_INT);
        if (!$id) { http_response_code(400); exit; }
        $query = $db->prepare('SELECT imagen, imagen_tipo FROM comprobantes_yape WHERE id=?');
        $query->execute([$id]);
        $image = $query->fetch(PDO::FETCH_ASSOC);
        if (!$image) { http_response_code(404); exit; }
        header('Content-Type: '.$image['imagen_tipo']);
        header('Content-Disposition: inline; filename="comprobante-'.$id.'"');
        echo $image['imagen'];
        exit;
    }
    if ($action === 'list' && $_SERVER['REQUEST_METHOD'] === 'GET') {
        $rows = $db->query('SELECT id, dni, prestamo_id, monto_centimos, estado, creado, revisado
            FROM comprobantes_yape ORDER BY creado DESC, id DESC LIMIT 300')->fetchAll(PDO::FETCH_ASSOC);
        echo json_encode($rows, JSON_THROW_ON_ERROR);
        exit;
    }
    if ($action === 'access-list' && $_SERVER['REQUEST_METHOD'] === 'GET') {
        $key = hash_hkdf('sha256', (string) $config['password'], 32, 'prestamos-client-access-v1');
        $accounts = array_fill_keys($db->query('SELECT dni FROM cliente_accesos')->fetchAll(PDO::FETCH_COLUMN), null);
        $row = $db->query('SELECT datos FROM registro WHERE id=1')->fetch(PDO::FETCH_ASSOC);
        $data = json_decode($row['datos'] ?? '{}', true, 512, JSON_THROW_ON_ERROR);
        $result = [];
        foreach ($data['friends'] ?? [] as $friend) {
            $dni = $friend['dni'] ?? '';
            if (!is_string($dni) || !array_key_exists($dni, $accounts)) continue;
            $clear = null;
            $secret = $friend['accessSecret'] ?? null;
            if (is_string($secret) && substr($secret, 0, 3) === 'v1:') {
                $raw = base64_decode(substr($secret, 3), true);
                if (!is_string($raw) || strlen($raw) < 29) throw new RuntimeException('Clave cifrada inválida');
                $opened = openssl_decrypt(substr($raw, 28), 'aes-256-gcm', $key, OPENSSL_RAW_DATA,
                    substr($raw, 0, 12), substr($raw, 12, 16));
                if (!is_string($opened)) throw new RuntimeException('No se pudo descifrar la clave');
                $clear = $opened;
            }
            $result[] = ['dni'=>$dni, 'clave'=>$clear];
        }
        echo json_encode($result, JSON_THROW_ON_ERROR);
        exit;
    }
    if ($_SERVER['REQUEST_METHOD'] !== 'POST'
        || !hash_equals($token, $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '')) {
        http_response_code(403);
        exit;
    }
    $input = json_decode(file_get_contents('php://input'), true);
    if (!is_array($input)) { http_response_code(400); exit; }
    if ($action === 'analyze') {
        $id = filter_var($input['id'] ?? null, FILTER_VALIDATE_INT);
        $apiKey = $config['openai_api_key'] ?? getenv('OPENAI_API_KEY');
        if (!$id || !is_string($apiKey) || trim($apiKey) === '') {
            http_response_code(503);
            echo json_encode(['error'=>'Configura openai_api_key en prestamos-config.php para analizar vouchers.']);
            exit;
        }
        $query = $db->prepare("SELECT imagen, imagen_tipo FROM comprobantes_yape WHERE id=? AND estado='pendiente'");
        $query->execute([$id]);
        $proof = $query->fetch(PDO::FETCH_ASSOC);
        if (!$proof) { http_response_code(404); echo json_encode(['error'=>'Comprobante no disponible.']); exit; }
        if (!in_array($proof['imagen_tipo'], ['image/jpeg','image/png','image/webp'], true)
            || strlen($proof['imagen']) > 4000000 || !function_exists('curl_init')) {
            http_response_code(503);
            echo json_encode(['error'=>'La imagen o la extensión cURL no está disponible.']);
            exit;
        }
        $fields = ['amount','sender','recipient','receipt','date','time'];
        $properties = ['is_yape'=>['type'=>'boolean']];
        foreach ($fields as $field) $properties[$field] = ['type'=>['string','null']];
        $payload = [
            'model'=>$config['openai_voucher_model'] ?? 'gpt-6.1-terra',
            'store'=>false,
            'reasoning'=>['effort'=>'low'],
            'max_output_tokens'=>700,
            'input'=>[[
                'role'=>'user',
                'content'=>[
                    ['type'=>'input_text','text'=>'Lee esta captura de un posible pago por Yape. Extrae solamente lo que se vea con claridad. amount: soles con punto decimal y dos decimales, sin S/. date: AAAA-MM-DD solo si aparece fecha completa; time: HH:MM solo si aparece. sender: quien envió, recipient: quien recibió, receipt: código o número de operación visible. Usa null si un dato falta o es dudoso. is_yape indica si parece una constancia de Yape; no afirmes que el dinero llegó ni que la imagen es auténtica.'],
                    ['type'=>'input_image','image_url'=>'data:'.$proof['imagen_tipo'].';base64,'.base64_encode($proof['imagen']),'detail'=>'high'],
                ],
            ]],
            'text'=>['format'=>[
                'type'=>'json_schema','name'=>'yape_voucher','strict'=>true,
                'schema'=>['type'=>'object','properties'=>$properties,
                    'required'=>array_keys($properties),'additionalProperties'=>false],
            ]],
        ];
        $request = curl_init('https://api.openai.com/v1/responses');
        curl_setopt_array($request, [
            CURLOPT_POST=>true, CURLOPT_RETURNTRANSFER=>true,
            CURLOPT_HTTPHEADER=>['Authorization: Bearer '.$apiKey, 'Content-Type: application/json'],
            CURLOPT_POSTFIELDS=>json_encode($payload, JSON_THROW_ON_ERROR),
            CURLOPT_CONNECTTIMEOUT=>10, CURLOPT_TIMEOUT=>60,
            CURLOPT_FOLLOWLOCATION=>false,
        ]);
        $rawResponse = curl_exec($request);
        $httpStatus = curl_getinfo($request, CURLINFO_HTTP_CODE);
        curl_close($request);
        if (!is_string($rawResponse) || $httpStatus !== 200) {
            error_log('Análisis Yape: API HTTP '.$httpStatus);
            http_response_code(502);
            echo json_encode(['error'=>'La IA no pudo leer el voucher. Revisa la clave API o inténtalo de nuevo.']);
            exit;
        }
        $response = json_decode($rawResponse, true, 512, JSON_THROW_ON_ERROR);
        $output = null;
        foreach ($response['output'] ?? [] as $item) {
            foreach ($item['content'] ?? [] as $content) {
                if (($content['type'] ?? '') === 'output_text') $output = $content['text'] ?? null;
            }
        }
        if (($response['status'] ?? '') !== 'completed' || !is_string($output)) {
            http_response_code(502);
            echo json_encode(['error'=>'La IA no devolvió una lectura completa.']);
            exit;
        }
        $analysis = json_decode($output, true, 512, JSON_THROW_ON_ERROR);
        if (!is_array($analysis) || !is_bool($analysis['is_yape'] ?? null)) {
            http_response_code(502);
            echo json_encode(['error'=>'La lectura del voucher no fue válida.']);
            exit;
        }
        foreach ($fields as $field) {
            if (!is_string($analysis[$field] ?? null)) $analysis[$field] = null;
            elseif (strlen($analysis[$field]) > 160) $analysis[$field] = substr($analysis[$field], 0, 160);
        }
        if ($analysis['amount'] !== null && !preg_match('/^\d{1,8}\.\d{2}$/D', $analysis['amount'])) $analysis['amount'] = null;
        if ($analysis['date'] !== null && !preg_match('/^\d{4}-\d{2}-\d{2}$/D', $analysis['date'])) $analysis['date'] = null;
        if ($analysis['time'] !== null && !preg_match('/^\d{2}:\d{2}$/D', $analysis['time'])) $analysis['time'] = null;
        echo json_encode($analysis, JSON_THROW_ON_ERROR);
        exit;
    }
    if ($action === 'confirm-payment') {
        $id = $input['id'] ?? null;
        $amount = $input['monto_centimos'] ?? null;
        $date = $input['fecha'] ?? null;
        $receipt = $input['recibo'] ?? '';
        $sender = $input['remitente'] ?? '';
        $today = (new DateTimeImmutable('now', new DateTimeZone('America/Lima')))->format('Y-m-d');
        $parsedDate = is_string($date) && preg_match('/^\d{4}-\d{2}-\d{2}$/D', $date)
            ? DateTimeImmutable::createFromFormat('!Y-m-d', $date) : false;
        if (!is_int($id) || $id < 1 || !is_int($amount) || $amount < 1 || $amount > 10000000000
            || !$parsedDate || $parsedDate->format('Y-m-d') !== $date || $date < '1900-01-01' || $date > $today
            || !is_string($receipt) || strlen($receipt) > 80
            || !is_string($sender) || strlen($sender) > 160) {
            http_response_code(400);
            echo json_encode(['error'=>'Revisa el monto, la fecha y los datos del voucher.']);
            exit;
        }
        $receipt = trim(preg_replace('/[\r\n]+/', ' ', $receipt));
        $sender = trim(preg_replace('/[\r\n]+/', ' ', $sender));
        $db->beginTransaction();
        $reject = static function (int $status, string $message) use ($db): void {
            $db->rollBack();
            http_response_code($status);
            echo json_encode(['error'=>$message]);
            exit;
        };
        $query = $db->prepare('SELECT dni, prestamo_id, estado FROM comprobantes_yape WHERE id=? FOR UPDATE');
        $query->execute([$id]);
        $proof = $query->fetch(PDO::FETCH_ASSOC);
        if (!$proof || $proof['estado'] !== 'pendiente') $reject(409, 'El comprobante ya fue revisado o no existe.');
        $row = $db->query('SELECT datos, revision FROM registro WHERE id=1 FOR UPDATE')->fetch(PDO::FETCH_ASSOC);
        if (!$row) $reject(503, 'No se encontró el registro de préstamos.');
        $data = json_decode($row['datos'], true, 512, JSON_THROW_ON_ERROR);
        $owners = array_values(array_filter($data['friends'] ?? [],
            static fn ($friend) => ($friend['dni'] ?? '') === $proof['dni']));
        if (count($owners) !== 1) $reject(409, 'El DNI del comprobante no identifica a un solo cliente.');
        $loanIndex = null;
        foreach ($data['loans'] ?? [] as $index=>$loan) {
            if (($loan['id'] ?? '') === $proof['prestamo_id']
                && ($loan['person'] ?? '') === $owners[0]['person']) {
                $loanIndex = $index;
                break;
            }
        }
        if ($loanIndex === null) $reject(409, 'El préstamo del comprobante ya no corresponde al cliente.');
        $loan = &$data['loans'][$loanIndex];
        $paid = 0;
        $normalizedReceipt = strtoupper(preg_replace('/\s+/', '', $receipt));
        foreach ($data['loans'] as $candidate) {
            foreach ($candidate['payments'] ?? [] as $payment) {
                if (($payment['proofId'] ?? null) === $id) $reject(409, 'Este comprobante ya tiene un abono.');
                if (strlen($normalizedReceipt) >= 6
                    && strtoupper(preg_replace('/\s+/', '', (string) ($payment['voucherReference'] ?? ''))) === $normalizedReceipt) {
                    $reject(409, 'Ese número de operación ya está registrado en otro abono.');
                }
            }
        }
        foreach ($loan['payments'] ?? [] as $payment) $paid += (int) ($payment['amount'] ?? 0);
        $balance = (int) ($loan['amount'] ?? 0) * (int) ($loan['count'] ?? 0) - $paid;
        if ($balance < $amount) $reject(409, 'El monto supera el saldo pendiente del préstamo.');
        if (!empty($loan['issued']) && $date < $loan['issued']) $reject(400, 'La fecha es anterior al préstamo.');
        $bytes = random_bytes(16);
        $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
        $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);
        $hex = bin2hex($bytes);
        $paymentId = substr($hex, 0, 8).'-'.substr($hex, 8, 4).'-'.substr($hex, 12, 4)
            .'-'.substr($hex, 16, 4).'-'.substr($hex, 20);
        $loan['payments'][] = [
            'id'=>$paymentId, 'amount'=>$amount, 'date'=>$date,
            'createdAt'=>(int) round(microtime(true) * 1000),
            'proofId'=>$id, 'voucherReference'=>$receipt, 'voucherSender'=>$sender,
        ];
        $db->prepare('UPDATE registro SET datos=?, revision=revision+1 WHERE id=1')
            ->execute([json_encode($data, JSON_THROW_ON_ERROR)]);
        $mark = $db->prepare("UPDATE comprobantes_yape SET estado='verificado', revisado=NOW()
            WHERE id=? AND estado='pendiente'");
        $mark->execute([$id]);
        if ($mark->rowCount() !== 1) $reject(409, 'El comprobante cambió. Recarga la página.');
        if (!empty($config['whatsapp_auto_enabled']) && !empty($owners[0]['whatsappConsent'])) {
            $phone = preg_replace('/\D+/', '', (string) ($owners[0]['phone'] ?? ''));
            if (preg_match('/^(?:9\d{8}|519\d{8})$/', $phone)) {
                $money = static fn (int $cents): string => 'S/ '.number_format($cents / 100, 2, '.', ',');
                $message = 'Hola '.$owners[0]['person'].', registramos tu abono de '.$money($amount)
                    .' del '.$parsedDate->format('d/m/Y').' para el préstamo N.º '.($loanIndex + 1)
                    .'.';
                $pending = [];
                $paidAfter = $paid + $amount;
                for ($index = 0; $index < (int) $loan['count']; $index++) {
                    $left = max(0, (int) $loan['amount'] - max(0, $paidAfter - $index * (int) $loan['amount']));
                    if ($left > 0) $pending[] = 'Cuota N.º '.($index + 1).': '.$money($left);
                }
                $message .= $pending
                    ? "\n\nCuotas pendientes (".count($pending)."):\n".implode("\n", $pending)
                    : "\n\nNo quedan cuotas pendientes.";
                $message .= "\nSaldo pendiente de todo el préstamo: ".$money($balance - $amount).'. Gracias.';
                $enqueue = $db->prepare("INSERT IGNORE INTO whatsapp_outbox
                    (message_key, kind, loan_id, message_text) VALUES (?, 'payment', ?, ?)");
                $enqueue->execute([hash('sha256', 'payment:'.$loan['id'].':'.$paymentId), $loan['id'], $message]);
            }
        }
        unset($loan);
        $db->commit();
        echo json_encode(['revision'=>(int) $row['revision'] + 1, 'data'=>$data], JSON_THROW_ON_ERROR);
        exit;
    }
    if ($action === 'review') {
        $id = filter_var($input['id'] ?? null, FILTER_VALIDATE_INT);
        $status = $input['estado'] ?? '';
        if (!$id || !in_array($status, ['verificado','rechazado'], true)) {
            http_response_code(400);
            exit;
        }
        $statement = $db->prepare("UPDATE comprobantes_yape SET estado=?, revisado=NOW()
            WHERE id=? AND estado='pendiente'");
        $statement->execute([$status, $id]);
        if ($statement->rowCount() !== 1) { http_response_code(409); exit; }
        echo json_encode(['ok'=>true]);
        exit;
    }
    http_response_code(404);
} catch (Throwable $error) {
    error_log('Clientes admin: '.get_class($error));
    http_response_code(503);
    echo json_encode(['error'=>'No se pudo completar la operación.']);
}
