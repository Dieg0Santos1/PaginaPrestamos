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
$loanCards = [];
$totalBalance = 0;
$nextDue = null;
$today = (new DateTimeImmutable('now', new DateTimeZone('America/Lima')))->format('Y-m-d');
if ($authenticated) {
    foreach ($loans as $loanIndex => $loan) {
        $paid = array_sum(array_column($loan['payments'] ?? [], 'amount'));
        $balance = max(0, (int) $loan['amount'] * (int) $loan['count'] - $paid);
        $totalBalance += $balance;
        $installments = [];
        for ($i = 0; $i < $loan['count']; $i++) {
            $date = new DateTimeImmutable($loan['first']);
            if ($loan['frequency'] === 'week') {
                $date = $date->modify('+'.($i * 7).' days');
            } elseif ($loan['frequency'] === 'fortnight') {
                $date = $date->modify('+'.($i * 15).' days');
            } else {
                $base = (new DateTimeImmutable($date->format('Y-m-01')))->modify('+'.$i.' months');
                $date = $base->setDate((int) $base->format('Y'), (int) $base->format('n'),
                    min((int) $date->format('j'), (int) $base->format('t')));
            }
            $left = max(0, (int) $loan['amount'] - max(0, $paid - $i * (int) $loan['amount']));
            $due = $date->format('Y-m-d');
            if ($left > 0 && ($nextDue === null || $due < $nextDue)) $nextDue = $due;
            $installments[] = ['number'=>$i+1,'date'=>$due,'amount'=>(int) $loan['amount'],'left'=>$left];
        }
        $loanCards[] = ['number'=>$loanIndex+1,'loan'=>$loan,'balance'=>$balance,'installments'=>$installments];
    }
}
$shortDate = static function (?string $value): string {
    if ($value === null) return 'Sin cuotas pendientes';
    $months = [1=>'ene.',2=>'feb.',3=>'mar.',4=>'abr.',5=>'may.',6=>'jun.',
        7=>'jul.',8=>'ago.',9=>'set.',10=>'oct.',11=>'nov.',12=>'dic.'];
    $date = new DateTimeImmutable($value);
    return $date->format('j').' '.$months[(int) $date->format('n')];
};
?>
<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#edf6f3">
<title>Mis préstamos</title>
<style>
:root{color-scheme:light;--ink:#123142;--muted:#607781;--green:#087b6b;--green-dark:#056354;--line:#e2ece9;--bg:#edf6f3}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
button,input,select{font:inherit}
button{cursor:pointer}
main{width:min(100%,900px);margin:auto;padding:28px 20px 48px}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:28px}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;letter-spacing:-.025em}
.brand-mark{display:grid;place-items:center;width:37px;height:37px;border-radius:12px;background:var(--green);color:white;font-size:21px}
.logout{border:1px solid #cfe2dc;background:#fff;color:var(--green-dark);padding:9px 16px;border-radius:10px;font-weight:700}
.logout:hover{background:#f3faf7}
.eyebrow{margin:0 0 4px;color:var(--green-dark);font-size:12px;font-weight:800;letter-spacing:.09em;text-transform:uppercase}
h1,h2,h3,p{margin-top:0}
h1{font-size:clamp(25px,5vw,34px);line-height:1.15;letter-spacing:-.04em;margin-bottom:8px}
h2{font-size:19px;line-height:1.25;letter-spacing:-.025em;margin-bottom:5px}
h3{font-size:16px;line-height:1.3;margin-bottom:0}
.intro{margin-bottom:22px}
.intro p:last-child,.section-subtitle,.hint{color:var(--muted)}
.intro p:last-child{margin-bottom:0}
.stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-bottom:30px}
.stat{background:#fff;border:1px solid var(--line);border-radius:17px;padding:18px 20px;box-shadow:0 5px 18px rgba(24,68,58,.035)}
.stat::before{content:"";display:block;width:30px;height:4px;border-radius:5px;background:#80d5bc;margin-bottom:14px}
.stat:nth-child(2)::before{background:#f6bd8f}
.stat-label{display:block;color:var(--muted);font-size:12px;font-weight:650;margin-bottom:4px}
.stat strong{display:block;font-size:clamp(21px,4vw,27px);line-height:1.2;letter-spacing:-.035em}
.section-heading{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin:0 0 12px}
.section-heading span{font-size:13px;color:var(--muted)}
.loan-card,.panel{background:white;border:1px solid var(--line);border-radius:18px;box-shadow:0 5px 18px rgba(24,68,58,.035)}
.loan-card{overflow:hidden;margin-bottom:12px}
.loan-head{padding:18px 20px;display:flex;justify-content:space-between;gap:12px;align-items:start;background:#fbfefd}
.loan-head p{color:var(--muted);font-size:13px;margin:4px 0 0}
.loan-balance{text-align:right;white-space:nowrap}
.loan-balance small{display:block;color:var(--muted);font-size:11px}
.loan-balance strong{display:block;font-size:17px}
.installments{list-style:none;margin:0;padding:0 20px}
.installment{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:14px 0;border-top:1px solid #edf2f0}
.installment-main{min-width:0}
.installment-main strong{display:block;font-size:14px}
.installment-main small{display:block;color:var(--muted);font-size:12px;margin-top:2px}
.installment-side{text-align:right;flex:none}
.installment-side strong{display:block;font-size:14px}
.badge{display:inline-block;border-radius:99px;padding:2px 8px;font-size:11px;font-weight:750;margin-top:4px}
.badge-paid,.badge-approved{background:#e2f6e9;color:#217447}
.badge-pending{background:#fff0df;color:#9a5a17}
.badge-overdue,.badge-rejected{background:#fde9e5;color:#a83e2e}
.panel{padding:22px;margin-top:17px}
.section-subtitle{font-size:13px;margin:0 0 18px}
.fields{display:grid;grid-template-columns:1fr 1fr;gap:12px}
label{display:block;font-size:13px;font-weight:700;margin-bottom:15px}
input,select{display:block;width:100%;min-height:46px;margin-top:7px;padding:10px 12px;border:1px solid #cddedb;border-radius:10px;background:white;color:var(--ink);outline:none}
input:focus,select:focus{border-color:var(--green);box-shadow:0 0 0 3px rgba(8,123,107,.12)}
input[type=file]{padding:10px;background:#f9fcfb;border-style:dashed}
input[type=file]::file-selector-button{border:0;border-radius:7px;background:#e3f2ed;color:var(--green-dark);font:inherit;font-weight:700;padding:7px 10px;margin-right:10px}
.hint{font-size:12px;font-weight:400;margin:5px 0 0}
.primary{display:block;width:100%;min-height:46px;border:0;border-radius:10px;background:var(--green);color:#fff;font-weight:800}
.primary:hover{background:var(--green-dark)}
.primary:disabled{background:#a7c6bd;cursor:not-allowed}
.alert{border-radius:11px;padding:12px 14px;margin:0 0 16px;font-size:13px;font-weight:650}
.alert-success{background:#dff4e9;color:#176544}
.alert-error{background:#fdebe6;color:#a33f2b}
.proof-list{list-style:none;padding:0;margin:0}
.proof-list li{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0;border-top:1px solid #edf2f0}
.proof-list li:first-child{border-top:0}
.proof-list strong{font-size:14px}
.proof-list small{display:block;color:var(--muted);font-size:12px}
.empty{padding:14px;border-radius:11px;background:#f7faf9;color:var(--muted);font-size:13px}
.login-wrap{max-width:430px;margin:9vh auto 0}
.login-wrap .panel{padding:28px}
.login-wrap .primary{margin-top:20px}
footer{text-align:center;color:#81959b;font-size:11px;margin-top:22px}
@media(max-width:580px){main{padding:18px 12px 34px}.topbar{margin-bottom:25px}.stats{gap:8px;margin-bottom:26px}.stat{padding:14px}.stat::before{margin-bottom:10px}.loan-head{padding:16px}.installments{padding:0 16px}.panel{padding:18px}.fields{grid-template-columns:1fr;gap:0}.loan-balance strong{font-size:15px}}
</style>
</head>
<body><main>
<header class="topbar">
  <div class="brand"><span class="brand-mark" aria-hidden="true">S/</span><span>Mis préstamos</span></div>
  <?php if ($authenticated): ?><form method="post"><input type="hidden" name="token" value="<?= $escape($_SESSION['token']) ?>"><button class="logout" name="logout" value="1">Salir</button></form><?php endif; ?>
</header>
<?php if (!$authenticated): ?>
<div class="login-wrap">
  <section class="panel">
    <p class="eyebrow">Acceso de clientes</p>
    <h1>Consulta tus préstamos</h1>
    <p class="section-subtitle">Ingresa con tu DNI y tu clave de acceso.</p>
    <?php if ($message): ?><p class="alert alert-error" role="alert"><?= $escape($message) ?></p><?php endif; ?>
    <form method="post">
      <input type="hidden" name="token" value="<?= $escape($_SESSION['token']) ?>">
      <label>DNI<input name="dni" inputmode="numeric" pattern="[0-9]{8}" maxlength="8" autocomplete="username" placeholder="8 dígitos" required></label>
      <label>Clave de acceso<input name="clave" type="password" autocomplete="current-password" required></label>
      <button class="primary" name="login" value="1">Ingresar</button>
    </form>
  </section>
</div>
<?php else: ?>
<div class="intro">
  <p class="eyebrow">Tu espacio personal</p>
  <h1>Hola, <?= $escape($friend['person']) ?></h1>
  <p>Revisa tus cuotas y envía tus comprobantes de pago.</p>
</div>
<?php if (isset($_GET['enviado'])): ?><p class="alert alert-success" role="status">Recibimos tu captura. Está pendiente de revisión.</p><?php endif; ?>
<?php if ($message): ?><p class="alert alert-error" role="alert"><?= $escape($message) ?></p><?php endif; ?>
<div class="stats" aria-label="Resumen de tus préstamos">
  <div class="stat"><span class="stat-label">Deuda pendiente</span><strong><?= $money((int) $totalBalance) ?></strong></div>
  <div class="stat"><span class="stat-label">Vencimiento más cercano</span><strong><?= $escape($shortDate($nextDue)) ?></strong></div>
</div>
<section aria-labelledby="loans-title">
  <div class="section-heading"><h2 id="loans-title">Mis préstamos</h2><span><?= count($loanCards) ?> <?= count($loanCards) === 1 ? 'préstamo' : 'préstamos' ?></span></div>
  <?php if (!$loanCards): ?><p class="empty">Aún no tienes préstamos registrados.</p><?php endif; ?>
  <?php foreach ($loanCards as $card): ?>
  <?php $frequencyLabel = ['week'=>'Semanal','fortnight'=>'Quincenal','month'=>'Mensual'][$card['loan']['frequency']] ?? 'Préstamo'; ?>
  <article class="loan-card">
    <div class="loan-head">
      <div><h3>Préstamo <?= $card['number'] ?> · <?= $escape($frequencyLabel) ?></h3><p><?= count($card['installments']) ?> cuotas de <?= $money((int) $card['loan']['amount']) ?></p></div>
      <div class="loan-balance"><small>Saldo pendiente</small><strong><?= $money((int) $card['balance']) ?></strong></div>
    </div>
    <ol class="installments">
      <?php foreach ($card['installments'] as $installment): ?>
      <?php $isPaid = $installment['left'] === 0; $isOverdue = !$isPaid && $installment['date'] < $today; ?>
      <li class="installment">
        <div class="installment-main"><strong>Cuota <?= $installment['number'] ?></strong><small>Vence <?= $escape((new DateTimeImmutable($installment['date']))->format('d/m/Y')) ?></small></div>
        <div class="installment-side"><strong><?= $money($isPaid ? $installment['amount'] : $installment['left']) ?></strong><span class="badge <?= $isPaid ? 'badge-paid' : ($isOverdue ? 'badge-overdue' : 'badge-pending') ?>"><?= $isPaid ? 'Pagada' : ($isOverdue ? 'Vencida' : 'Pendiente') ?></span></div>
      </li>
      <?php endforeach; ?>
    </ol>
  </article>
  <?php endforeach; ?>
</section>
<section class="panel" aria-labelledby="upload-title">
  <p class="eyebrow">Pagos</p>
  <h2 id="upload-title">Enviar comprobante de Yape</h2>
  <p class="section-subtitle">Tu pago se revisará antes de registrar el abono.</p>
  <form method="post" enctype="multipart/form-data">
    <input type="hidden" name="token" value="<?= $escape($_SESSION['token']) ?>">
    <div class="fields">
      <label>Préstamo
        <select name="prestamo" required>
          <?php foreach ($loanCards as $card): ?><option value="<?= $escape($card['loan']['id']) ?>">Préstamo <?= $card['number'] ?> · <?= $escape(['week'=>'Semanal','fortnight'=>'Quincenal','month'=>'Mensual'][$card['loan']['frequency']] ?? 'Cuotas') ?></option><?php endforeach; ?>
        </select>
      </label>
      <label>Monto enviado (S/)
        <input name="monto" type="number" inputmode="decimal" min="0.01" max="99999999.99" step="0.01" placeholder="0.00" required>
      </label>
    </div>
    <label>Captura de Yape
      <input name="captura" type="file" accept="image/jpeg,image/png,image/webp" required>
      <span class="hint">JPG, PNG o WebP · máximo 4 MB</span>
    </label>
    <button class="primary" name="upload" value="1" <?= !$loans ? 'disabled' : '' ?>>Enviar comprobante</button>
  </form>
</section>
<section class="panel" aria-labelledby="proofs-title">
  <h2 id="proofs-title">Comprobantes enviados</h2>
  <p class="section-subtitle">Aquí puedes seguir el estado de tus envíos.</p>
  <?php if (!$proofs): ?><p class="empty">Aún no enviaste comprobantes.</p><?php endif; ?>
  <ul class="proof-list">
    <?php foreach ($proofs as $proof): ?>
    <?php $status = (string) $proof['estado']; $statusClass = $status === 'aprobado' ? 'badge-approved' : ($status === 'rechazado' ? 'badge-rejected' : 'badge-pending'); ?>
    <li><div><strong><?= $money((int) $proof['monto_centimos']) ?></strong><small><?= $escape((new DateTimeImmutable($proof['creado']))->format('d/m/Y · H:i')) ?></small></div><span class="badge <?= $statusClass ?>"><?= $escape(ucfirst($status)) ?></span></li>
    <?php endforeach; ?>
  </ul>
</section>
<?php endif; ?>
<footer>Tus datos y comprobantes son privados.</footer>
</main></body></html>
