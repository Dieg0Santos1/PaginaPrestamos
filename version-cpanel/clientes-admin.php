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
