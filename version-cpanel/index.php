<?php
declare(strict_types=1);
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header("Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
if (empty($_SERVER['HTTPS']) || $_SERVER['HTTPS'] === 'off') {
    http_response_code(403);
    exit('Abre el sistema mediante HTTPS.');
}
$path = dirname(__DIR__, 2).'/prestamos-config.php';
$config = is_readable($path) ? require $path : [];
$loginUser = $config['login_user'] ?? '';
$loginPassword = $config['login_password'] ?? '';
if (!is_string($loginUser) || strlen($loginUser) < 3
    || !is_string($loginPassword) || strlen($loginPassword) < 12
    || $loginUser === 'REEMPLAZAR_USUARIO' || $loginPassword === 'REEMPLAZAR_CONTRASENA') {
    http_response_code(503);
    exit('Configura el usuario y la contraseña del sistema.');
}

session_name('prestamos_session');
ini_set('session.use_strict_mode', '1');
session_set_cookie_params(['secure'=>true,'httponly'=>true,'samesite'=>'Strict']);
session_start();
$_SESSION['token'] ??= bin2hex(random_bytes(32));
$token = $_SESSION['token'];
$api = isset($_GET['api']);
$post = $_SERVER['REQUEST_METHOD'] === 'POST';
$credentialsVersion = hash('sha256', $loginUser."\0".$loginPassword);
$auth = isset($_SESSION['auth'], $_SESSION['seen'])
    && hash_equals($_SESSION['auth'], $credentialsVersion)
    && time() - $_SESSION['seen'] < 28800;
if (!$api && $post && hash_equals($token, (string) ($_POST['token'] ?? ''))) {
    if (isset($_POST['logout'])) {
        $_SESSION = [];
        session_regenerate_id(true);
        header('Location: ./', true, 303);
        exit;
    }
    $submittedUser = $_POST['login_user'] ?? null;
    $submittedPassword = $_POST['login_password'] ?? null;
    if (is_string($submittedUser) && is_string($submittedPassword)
        && hash_equals($loginUser, $submittedUser)
        && hash_equals($loginPassword, $submittedPassword)) {
        session_regenerate_id(true);
        $_SESSION = ['auth'=>$credentialsVersion,'seen'=>time(),'token'=>bin2hex(random_bytes(32))];
        header('Location: ./', true, 303);
        exit;
    }
}
if (!$auth) {
    if ($api) { http_response_code(401); exit; }
    ?>
<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mis préstamos</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f1f6f7;color:#172a39;font:16px system-ui}main{box-sizing:border-box;width:min(92%,420px);padding:28px;background:white;border-radius:16px}input,button{box-sizing:border-box;display:block;width:100%;margin-top:10px;padding:12px;font:inherit;border:1px solid #b7c9cc;border-radius:8px}button{background:#08715f;color:white}.whatsapp-link{position:relative;display:inline-block;width:40px;height:40px;padding:0;border:0;border-radius:10px;background:#00b985;color:#fff;cursor:pointer;vertical-align:middle;box-shadow:0 2px 5px #122b2633}.whatsapp-link::before{content:"";position:absolute;left:10px;top:9px;width:18px;height:17px;border:2px solid #fff;border-radius:50%}.whatsapp-link::after{content:"";position:absolute;left:10px;bottom:8px;width:6px;height:6px;border-left:2px solid #fff;border-bottom:2px solid #fff;transform:skew(-18deg) rotate(-12deg)}.whatsapp-link:hover{background:#009f73}.whatsapp-link:disabled{opacity:.5;cursor:default}#cashMovementsDialog{width:min(700px,calc(100% - 24px));max-height:85vh;overflow:auto;border:1px solid var(--line);border-radius:16px;padding:24px;color:var(--ink);background:var(--paper)}#cashMovementsDialog::backdrop{background:#142c3690}.cash-dialog-header{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:12px}.cash-dialog-header h2{margin:0}.cash-history-button{margin-left:12px;background:#e6eff0;color:var(--ink)}#clientLoans{width:min(860px,calc(100% - 24px));max-height:85vh;overflow:auto;border:1px solid var(--line);border-radius:16px;padding:clamp(14px,3vw,28px);color:var(--ink);background:var(--bg)}#clientLoans::backdrop{background:#142c3690}#clientLoans h3{margin:0}#clientLoans article{margin-bottom:10px}#clientSearch{max-width:420px;margin:0 0 12px}.client-loans-cell{white-space:nowrap;padding-right:20px}.client-actions{white-space:nowrap}.client-actions button{margin:2px}.client-actions button:last-child{background:#fff0ee;color:#932e29}#friend{padding:12px 0 18px}#cancelClient{background:#e6eff0;color:var(--ink)}
</style>
<main><h1>Mis préstamos</h1><form method="post"><input type="hidden" name="token" value="<?= htmlspecialchars($token, ENT_QUOTES) ?>"><label>Usuario<input name="login_user" autocomplete="username" required></label><label>Contraseña<input type="password" name="login_password" autocomplete="current-password" required></label><button>Ingresar</button></form><?php if ($post): ?><p role="alert">Comprueba tu usuario y contraseña.</p><?php endif; ?></main></html>
    <?php
    exit;
}
$_SESSION['seen'] = time();
session_write_close();
if ($api && (!$post || !hash_equals($token, $_SERVER['HTTP_X_CSRF_TOKEN'] ?? ''))) {
    http_response_code(403);
    exit;
}
try {
    $db = new PDO('mysql:host='.$config['host'].';dbname='.$config['database'].';charset=utf8mb4',
        $config['user'], $config['password'],
        [PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION,PDO::ATTR_EMULATE_PREPARES=>false]);
    if ($api) {
        $raw = file_get_contents('php://input', false, null, 0, 4000001);
        if ($raw === false || strlen($raw) > 4000000) { http_response_code(413); exit; }
        $request = json_decode($raw);
        if (!is_int($request->revision ?? null) || !is_array($request->data->loans ?? null)
            || !is_array($request->data->friends ?? null)) { http_response_code(400); exit; }
        $db->beginTransaction();
        $previous = $db->query('SELECT datos, revision FROM registro WHERE id=1 FOR UPDATE')->fetch(PDO::FETCH_ASSOC);
        if (!$previous || (int) $previous['revision'] !== $request->revision) {
            $db->rollBack();
            http_response_code(409);
            exit;
        }
        $db->prepare('UPDATE registro SET datos=?, revision=revision+1 WHERE id=1')
            ->execute([json_encode($request->data, JSON_THROW_ON_ERROR)]);
        if (!empty($config['whatsapp_auto_enabled']) && empty($request->restore)) {
            $oldData = json_decode($previous['datos'], false, 512, JSON_THROW_ON_ERROR);
            $oldLoans = [];
            foreach ($oldData->loans ?? [] as $loan) {
                if (is_string($loan->id ?? null)) $oldLoans[$loan->id] = $loan;
            }
            $consented = [];
            foreach ($request->data->friends as $friend) {
                if (is_string($friend->person ?? null) && ($friend->whatsappConsent ?? false) === true
                    && is_string($friend->phone ?? null)) {
                    $phone = preg_replace('/\D+/', '', $friend->phone);
                    if (preg_match('/^(?:9\d{8}|519\d{8})$/', $phone)) $consented[$friend->person] = true;
                }
            }
            $enqueue = $db->prepare("INSERT IGNORE INTO whatsapp_outbox
                (message_key, kind, loan_id) VALUES (?, 'created', ?)");
            foreach ($request->data->loans as $loan) {
                if (!is_string($loan->id ?? null) || !is_string($loan->person ?? null)
                    || isset($oldLoans[$loan->id]) || empty($consented[$loan->person])) continue;
                $enqueue->execute([hash('sha256', 'created:'.$loan->id), $loan->id]);
            }
            $cancelPayment = $db->prepare("UPDATE whatsapp_outbox SET status='skipped',
                last_error='Abono editado o eliminado antes del envío'
                WHERE message_key=? AND status='pending'");
            $enqueuePayment = $db->prepare("INSERT IGNORE INTO whatsapp_outbox
                (message_key, kind, loan_id, message_text) VALUES (?, 'payment', ?, ?)");
            $money = static fn (int $cents): string => 'S/ '.number_format($cents / 100, 2, '.', ',');
            foreach ($request->data->loans as $loanIndex=>$loan) {
                if (!is_string($loan->id ?? null) || !isset($oldLoans[$loan->id])) continue;
                $oldPayments = $oldLoans[$loan->id]->payments ?? [];
                $newPayments = $loan->payments ?? [];
                if (!is_array($oldPayments) || !is_array($newPayments)) continue;
                $currentPayments = [];
                foreach ($newPayments as $payment) {
                    if (is_string($payment->id ?? null)) $currentPayments[$payment->id] = $payment;
                }
                foreach ($oldPayments as $payment) {
                    if (!is_string($payment->id ?? null)) continue;
                    if (!isset($currentPayments[$payment->id]) || $currentPayments[$payment->id] != $payment) {
                        $cancelPayment->execute([hash('sha256', 'payment:'.$loan->id.':'.$payment->id)]);
                    }
                }
                if (empty($consented[$loan->person ?? '']) || count($newPayments) !== count($oldPayments) + 1) continue;
                foreach ($oldPayments as $index=>$payment) {
                    if ($payment != $newPayments[$index]) continue 2;
                }
                $payment = $newPayments[count($oldPayments)];
                if (!is_string($payment->id ?? null)
                    || !preg_match('/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i', $payment->id)
                    || !is_int($payment->amount ?? null) || $payment->amount <= 0
                    || !is_string($payment->date ?? null) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $payment->date)
                    || !is_int($loan->amount ?? null) || $loan->amount <= 0
                    || !is_int($loan->count ?? null) || $loan->count < 1 || $loan->count > 120) continue;
                $paidBefore = 0;
                foreach ($oldPayments as $oldPayment) $paidBefore += (int) ($oldPayment->amount ?? 0);
                $paidAfter = $paidBefore + $payment->amount;
                if ($paidAfter > $loan->amount * $loan->count) continue;
                $balance = max(0, $loan->amount * $loan->count - $paidAfter);
                $person = trim(preg_replace('/[\r\n]+/', ' ', (string) $loan->person));
                $message = 'Hola '.$person.', registramos tu abono de '.$money($payment->amount)
                    .' del '.date('d/m/Y', strtotime($payment->date))
                    .' para el préstamo N.º '.($loanIndex + 1).'.';
                for ($index = 0; $index < $loan->count; $index++) {
                    $before = max(0, $loan->amount - max(0, $paidBefore - $index * $loan->amount));
                    $after = max(0, $loan->amount - max(0, $paidAfter - $index * $loan->amount));
                    if ($after > 0 && $after < $before) {
                        $message .= "\nSaldo pendiente de la cuota N.º ".($index + 1).': '.$money($after).'.';
                        break;
                    }
                }
                $message .= "\n\nSaldo pendiente de todo el préstamo: ".$money($balance).'. Gracias.';
                $enqueuePayment->execute([hash('sha256', 'payment:'.$loan->id.':'.$payment->id), $loan->id, $message]);
            }
        }
        $db->commit();
        header('Content-Type: application/json');
        echo json_encode(['revision'=>$request->revision+1]);
        exit;
    }
    $row = $db->query('SELECT datos, revision FROM registro WHERE id=1')->fetch(PDO::FETCH_ASSOC);
    if (!$row) throw new RuntimeException('Registro inicial ausente');
    $bootstrap = json_encode(['data'=>json_decode($row['datos'],false,512,JSON_THROW_ON_ERROR),
        'revision'=>(int)$row['revision'],'token'=>$token],
        JSON_HEX_TAG|JSON_HEX_AMP|JSON_HEX_APOS|JSON_HEX_QUOT|JSON_THROW_ON_ERROR);
} catch (Throwable $error) {
    if (isset($db) && $db->inTransaction()) $db->rollBack();
    error_log('Mis préstamos: '.get_class($error));
    http_response_code(503);
    exit('El registro no está disponible. Revisa la configuración de la base de datos.');
}

$manifestPath = __DIR__.'/react-dist/manifest.json';
$manifest = is_readable($manifestPath) ? json_decode(file_get_contents($manifestPath), true) : null;
$entry = is_array($manifest) ? ($manifest['index.html'] ?? null) : null;
if (!is_array($entry) || empty($entry['file'])) {
    http_response_code(503);
    exit('Falta la compilación de React. Ejecuta npm run build y sube react-dist.');
}
$script = 'react-dist/'.$entry['file'];
$styles = array_map(static fn ($file) => 'react-dist/'.$file, $entry['css'] ?? []);
?>
<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mis préstamos</title>
<?php foreach ($styles as $style): ?><link rel="stylesheet" href="<?= htmlspecialchars($style, ENT_QUOTES) ?>"><?php endforeach; ?>
</head>
<body>
<div id="root"></div>
<script>window.__PRESTAMOS_BOOTSTRAP__ = <?= $bootstrap ?>;</script>
<script type="module" src="<?= htmlspecialchars($script, ENT_QUOTES) ?>"></script>
</body>
</html>
