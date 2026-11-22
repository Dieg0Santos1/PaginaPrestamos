<?php
declare(strict_types=1);

// Ejecutar solo desde la terminal de cPanel, fuera de public_html.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
if ($argc > 2 || ($argc === 2 && $argv[1] !== '--apply')) {
    fwrite(STDERR, "Uso: php prestamos-autorizar-clientes.php [--apply]\n");
    exit(2);
}

$configPath = __DIR__.'/prestamos-config.php';
if (!is_readable($configPath)) {
    fwrite(STDERR, "Falta prestamos-config.php en el mismo directorio.\n");
    exit(1);
}
$config = require $configPath;

try {
    $db = new PDO(
        'mysql:host='.$config['host'].';dbname='.$config['database'].';charset=utf8mb4',
        $config['user'],
        $config['password'],
        [PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION, PDO::ATTR_EMULATE_PREPARES=>false]
    );
    $db->beginTransaction();
    $row = $db->query('SELECT datos, revision FROM registro WHERE id=1 FOR UPDATE')->fetch(PDO::FETCH_ASSOC);
    if (!$row || !is_string($row['datos'])) throw new RuntimeException('No se encontró el registro principal.');
    $data = json_decode($row['datos'], false, 512, JSON_THROW_ON_ERROR);
    if (!is_object($data) || !isset($data->friends) || !is_array($data->friends)) {
        throw new RuntimeException('El registro no contiene una lista de clientes válida.');
    }

    $total = count($data->friends);
    $pending = 0;
    $withoutPhone = 0;
    foreach ($data->friends as $friend) {
        if (!is_object($friend) || !is_string($friend->person ?? null)) {
            throw new RuntimeException('Hay una ficha de cliente inválida.');
        }
        if (($friend->whatsappConsent ?? false) !== true) $pending++;
        $phone = preg_replace('/\D+/', '', (string) ($friend->phone ?? ''));
        if (!preg_match('/^(?:9\d{8}|519\d{8})$/', $phone)) $withoutPhone++;
    }
    fwrite(STDOUT, "Clientes: $total. Sin autorización marcada: $pending. Sin celular peruano válido: $withoutPhone.\n");
    if ($argc === 1) {
        fwrite(STDOUT, "Vista previa: no se cambió nada. Usa --apply solo si todos ya dieron su autorización.\n");
        $db->rollBack();
        exit(0);
    }
    if ($pending === 0) {
        fwrite(STDOUT, "No hay clientes por actualizar.\n");
        $db->rollBack();
        exit(0);
    }

    // La copia se guarda junto a la configuración privada, fuera de public_html.
    $backupPath = __DIR__.'/prestamos-antes-autorizacion-'.date('Ymd-His').'-'.bin2hex(random_bytes(3)).'.json';
    umask(0077);
    $backup = fopen($backupPath, 'x');
    if ($backup === false) throw new RuntimeException('No se pudo crear la copia de seguridad.');
    if (!chmod($backupPath, 0600)) {
        fclose($backup);
        throw new RuntimeException('No se pudieron proteger los permisos de la copia de seguridad.');
    }
    $written = fwrite($backup, $row['datos']);
    $closed = fclose($backup);
    if ($written !== strlen($row['datos']) || !$closed) {
        throw new RuntimeException('La copia de seguridad quedó incompleta.');
    }

    foreach ($data->friends as $friend) $friend->whatsappConsent = true;
    $json = json_encode($data, JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR);
    $db->prepare('UPDATE registro SET datos=?, revision=revision+1 WHERE id=1')
        ->execute([$json]);
    $db->commit();
    fwrite(STDOUT, "Actualizados: $pending. Copia: $backupPath\n");
    fwrite(STDOUT, "Recarga la página para ver el cambio. Los avisos de creación anteriores no se envían de nuevo.\n");
} catch (Throwable $error) {
    if (isset($db) && $db->inTransaction()) $db->rollBack();
    fwrite(STDERR, 'Error: '.$error->getMessage()."\n");
    exit(1);
}
