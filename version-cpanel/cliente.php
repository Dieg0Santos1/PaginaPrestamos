<?php
declare(strict_types=1);

header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header("Content-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
if (empty($_SERVER['HTTPS']) || $_SERVER['HTTPS'] === 'off') {
    http_response_code(403);
    exit('Abre esta página mediante HTTPS.');
}
$path = dirname(__DIR__, 2).'/prestamos-config.php';
$config = is_readable($path) ? require $path : [];
if (!isset($config['host'], $config['database'], $config['user'], $config['password'])) {
    http_response_code(503);
    exit('Falta configurar la base de datos.');
}
session_name('prestamos_cliente');
ini_set('session.use_strict_mode', '1');
session_set_cookie_params(['secure'=>true,'httponly'=>true,'samesite'=>'Strict']);
session_start();
$_SESSION['token'] ??= bin2hex(random_bytes(32));
$escape = static fn ($value): string => htmlspecialchars((string) $value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
$money = static fn (int $cents): string => 'S/ '.number_format($cents/100, 2, '.', ',');
$message = '';
try {
    $db = new PDO('mysql:host='.$config['host'].';dbname='.$config['database'].';charset=utf8mb4',
        $config['user'], $config['password'],
        [PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION, PDO::ATTR_EMULATE_PREPARES=>false]);
    $post = $_SERVER['REQUEST_METHOD'] === 'POST';
    $validToken = $post && hash_equals($_SESSION['token'], (string) ($_POST['token'] ?? ''));
    if ($post && !$validToken) {
        http_response_code(403);
        exit('Formulario vencido. Actualiza la página.');
    }
    if ($post && isset($_POST['logout'])) {
        $_SESSION = [];
        session_regenerate_id(true);
        header('Location: cliente.php', true, 303);
        exit;
    }
    if ($post && isset($_POST['login'])) {
        $dni = $_POST['dni'] ?? '';
        $key = $_POST['clave'] ?? '';
        if (is_string($dni) && preg_match('/^\d{8}$/D', $dni) && is_string($key)) {
            $query = $db->prepare('SELECT clave_hash FROM cliente_accesos WHERE dni=?');
            $query->execute([$dni]);
            $hash = $query->fetchColumn();
            if ($hash && password_verify($key, $hash)) {
                session_regenerate_id(true);
                $_SESSION = ['dni'=>$dni, 'version'=>hash('sha256', $hash),
                    'seen'=>time(), 'token'=>bin2hex(random_bytes(32))];
                header('Location: cliente.php', true, 303);
                exit;
            }
        }
        usleep(300000);
        $message = 'DNI o clave incorrectos.';
    }
    $dni = $_SESSION['dni'] ?? '';
    $authenticated = false;
    if (is_string($dni) && preg_match('/^\d{8}$/D', $dni) && isset($_SESSION['version'], $_SESSION['seen'])
        && time()-$_SESSION['seen'] < 28800) {
        $query = $db->prepare('SELECT clave_hash, nombre_cliente FROM cliente_accesos WHERE dni=?');
        $query->execute([$dni]);
        $access = $query->fetch(PDO::FETCH_ASSOC);
        $authenticated = $access && hash_equals($_SESSION['version'], hash('sha256', $access['clave_hash']));
    }
    $friend = null;
    $loans = [];
    if ($authenticated) {
        $_SESSION['seen'] = time();
        $row = $db->query('SELECT datos FROM registro WHERE id=1')->fetch(PDO::FETCH_ASSOC);
        $data = json_decode($row['datos'] ?? '{}', true, 512, JSON_THROW_ON_ERROR);
        $matches = array_values(array_filter($data['friends'] ?? [],
            static fn ($item) => ($item['dni'] ?? '') === $dni));
        if (count($matches) === 1 && $matches[0]['person'] === $access['nombre_cliente']) {
            $friend = $matches[0];
            $loans = array_values(array_filter($data['loans'] ?? [],
                static fn ($loan) => ($loan['person'] ?? '') === $friend['person']));
        } else {
            $authenticated = false;
        }
    }
    if ($authenticated && $post && isset($_POST['upload'])) {
        $loanId = $_POST['prestamo'] ?? '';
        $loan = null;
        foreach ($loans as $candidate) {
            if (($candidate['id'] ?? '') === $loanId) { $loan = $candidate; break; }
        }
        $amount = $_POST['monto'] ?? '';
        $cents = is_string($amount) && preg_match('/^\d{1,8}(?:\.\d{1,2})?$/D', $amount)
            ? (int) round((float) $amount*100) : 0;
        $file = $_FILES['captura'] ?? null;
        if (!$loan || $cents < 1 || !$file || is_array($file['error'])
            || $file['error'] !== UPLOAD_ERR_OK || $file['size'] > 4000000 || $file['size'] < 1
            || !is_uploaded_file($file['tmp_name'])) {
            $message = 'Comprueba el préstamo, el monto y la imagen. Máximo 4 MB.';
        } else {
            $type = (new finfo(FILEINFO_MIME_TYPE))->file($file['tmp_name']);
            $dimensions = @getimagesize($file['tmp_name']);
            if (!in_array($type, ['image/jpeg','image/png','image/webp'], true) || $dimensions === false) {
                $message = 'Usa una captura JPG, PNG o WebP.';
            } else {
                $image = file_get_contents($file['tmp_name']);
                $insert = $db->prepare('INSERT INTO comprobantes_yape
                    (dni, prestamo_id, monto_centimos, imagen, imagen_tipo) VALUES (?, ?, ?, ?, ?)');
                $insert->execute([$dni, $loanId, $cents, $image, $type]);
                header('Location: cliente.php?enviado=1', true, 303);
                exit;
            }
        }
    }
    $proofs = [];
    if ($authenticated) {
        $query = $db->prepare('SELECT prestamo_id, monto_centimos, estado, creado
            FROM comprobantes_yape WHERE dni=? ORDER BY creado DESC LIMIT 30');
        $query->execute([$dni]);
        $proofs = $query->fetchAll(PDO::FETCH_ASSOC);
    }
} catch (Throwable $error) {
    error_log('Portal cliente: '.get_class($error));
    http_response_code(503);
    exit('El portal no está disponible en este momento.');
}
?>
<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mis préstamos</title><style>
*{box-sizing:border-box}body{margin:0;background:#f1f6f7;color:#172a39;font:16px system-ui}
main{max-width:850px;margin:auto;padding:24px}section{background:white;border:1px solid #dce7e8;border-radius:14px;padding:20px;margin:16px 0}
header{display:flex;justify-content:space-between;align-items:center}h1{font-size:1.7rem}h2{font-size:1.15rem}
label{display:block;margin:12px 0}input,select,button{font:inherit;padding:10px;border-radius:8px;border:1px solid #b7c9cc}
input,select{display:block;width:100%;margin-top:5px}button{background:#08715f;color:white;border:0;cursor:pointer}
ul{padding-left:20px}li{margin:8px 0}.notice{color:#9a352f}.paid{color:#08715f}
</style></head><body><main>
<header><h1>Mis préstamos</h1><?php if ($authenticated): ?><form method="post"><input type="hidden" name="token" value="<?= $escape($_SESSION['token']) ?>"><button name="logout" value="1">Salir</button></form><?php endif; ?></header>
<?php if (!$authenticated): ?>
<section><h2>Acceso de clientes</h2><form method="post"><input type="hidden" name="token" value="<?= $escape($_SESSION['token']) ?>">
<label>DNI<input name="dni" inputmode="numeric" pattern="[0-9]{8}" maxlength="8" autocomplete="username" required></label>
<label>Clave de acceso<input name="clave" type="password" autocomplete="current-password" required></label>
<button name="login" value="1">Ingresar</button></form><p class="notice"><?= $escape($message) ?></p></section>
<?php else: ?>
<p>Hola, <?= $escape($friend['person']) ?>.</p>
<?php if (isset($_GET['enviado'])): ?><p class="paid">Recibimos tu captura. Está pendiente de revisión.</p><?php endif; ?>
<?php if ($message): ?><p class="notice"><?= $escape($message) ?></p><?php endif; ?>
<section><h2>Tus préstamos</h2>
<?php if (!$loans): ?><p>No tienes préstamos registrados.</p><?php endif; ?>
<?php foreach ($loans as $loan): ?>
<?php $paid = array_sum(array_column($loan['payments'] ?? [], 'amount')); $balance = max(0, $loan['amount']*$loan['count']-$paid); ?>
<article><h3>Préstamo <?= $escape($loan['id']) ?></h3>
<p>Cuota <?= $money((int) $loan['amount']) ?> · Total pendiente <?= $money((int) $balance) ?></p>
<ul><?php for ($i=0; $i<$loan['count']; $i++): ?>
<?php $date = new DateTimeImmutable($loan['first']); if ($loan['frequency']==='week') $date=$date->modify('+'.($i*7).' days'); elseif ($loan['frequency']==='fortnight') $date=$date->modify('+'.($i*15).' days'); else { $base=(new DateTimeImmutable($date->format('Y-m-01')))->modify('+'.$i.' months'); $date=$base->setDate((int) $base->format('Y'), (int) $base->format('n'), min((int) $date->format('j'), (int) $base->format('t'))); } ?>
<li>Cuota <?= $i+1 ?> · <?= $date->format('d/m/Y') ?> · Pendiente <?= $money((int) max(0,$loan['amount']-max(0,$paid-$i*$loan['amount']))) ?></li>
<?php endfor; ?></ul></article>
<?php endforeach; ?></section>
<section><h2>Enviar captura de Yape</h2><p>La captura se revisará antes de registrar el abono.</p>
<form method="post" enctype="multipart/form-data"><input type="hidden" name="token" value="<?= $escape($_SESSION['token']) ?>">
<label>Préstamo<select name="prestamo" required><?php foreach ($loans as $loan): ?><option value="<?= $escape($loan['id']) ?>"><?= $escape($loan['id']) ?> · <?= $escape($loan['person']) ?></option><?php endforeach; ?></select></label>
<label>Monto enviado (S/)<input name="monto" type="number" min="0.01" max="99999999.99" step="0.01" required></label>
<label>Captura JPG, PNG o WebP (máximo 4 MB)<input name="captura" type="file" accept="image/jpeg,image/png,image/webp" required></label>
<button name="upload" value="1" <?= !$loans ? 'disabled' : '' ?>>Enviar comprobante</button></form></section>
<section><h2>Comprobantes enviados</h2><?php if (!$proofs): ?><p>Aún no enviaste comprobantes.</p><?php endif; ?>
<ul><?php foreach ($proofs as $proof): ?><li><?= $escape($proof['creado']) ?> · <?= $money((int) $proof['monto_centimos']) ?> · <?= $escape($proof['estado']) ?></li><?php endforeach; ?></ul></section>
<?php endif; ?>
</main></body></html>

