# Mis préstamos: React + Vite en cPanel

La interfaz está en `../react-app`. PHP conserva el inicio de sesión y la API que lee y guarda el JSON en MySQL. La tabla `registro` y el formato de respaldo siguen siendo los mismos.

## Probar en esta PC

Desde `PaginaPrestamos/react-app` ejecuta:

```powershell
npm.cmd install
npm.cmd run dev
```

Abre la dirección que muestra Vite, normalmente `http://127.0.0.1:5173/`. Esta prueba guarda los datos en el navegador local. Puedes importar una copia JSON desde Respaldo. La versión de Vite no usa la base de datos del hosting.

## Compilar y publicar

1. En `PaginaPrestamos/react-app`, ejecuta `npm.cmd run build`. Esto genera `../version-cpanel/react-dist/manifest.json` y los archivos de `react-dist/assets/`. La compilación elimina el HTML de Vite para que la entrada pública siga siendo `index.php`.
2. En cPanel, comprueba que el subdominio `prestamos.dadtvplay.com` tiene raíz propia en `public_html/prestamos` y HTTPS activo.
3. En esa raíz, reemplaza `index.php` y sube la carpeta **`react-dist` completa**. La estructura debe ser:

   También puedes subir `../prestamos-react-cpanel.zip` a esa raíz y extraerlo allí; contiene exactamente esos archivos.

   ```text
   /home/usuario/
   ├── prestamos-config.php
   └── public_html/prestamos/
       ├── index.php
       └── react-dist/
           ├── manifest.json
           └── assets/
               ├── index-....js
               └── index-....css
   ```

4. Mantén `prestamos-config.php` fuera de `public_html`. Copia `prestamos-config.example.php` como punto de partida y coloca allí los datos de MySQL, `login_user` y una `login_password` de al menos 12 caracteres. **No subas el archivo de ejemplo con valores reales.**
5. Si todavía no existe la tabla, importa `base.sql` en la base mediante phpMyAdmin. El usuario MySQL necesita `SELECT`, `UPDATE` e `INSERT` para el funcionamiento normal con avisos automáticos.
6. Abre `https://prestamos.dadtvplay.com/`, inicia sesión y recarga con Ctrl + F5. Los registros que ya están en MySQL se muestran sin volver a importar el respaldo.

Al actualizar la interfaz, repite la compilación y reemplaza `index.php` y `react-dist`. No importes de nuevo un respaldo a menos que quieras reemplazar el registro compartido. El código fuente `react-app`, `node_modules` y el JSON de respaldo no se suben a la carpeta pública.

## Activar avisos automáticos por WhatsApp

Esta aplicación puede usar **la misma sesión conectada** de WasenderAPI que otra página. No crea, reinicia ni desconecta sesiones. Mantiene su propia cola en la tabla `whatsapp_outbox` y envía como máximo un mensaje por ejecución del cron. Ambas páginas comparten el límite de envíos de esa sesión; una respuesta HTTP 429 se vuelve a intentar más tarde.

1. Importa de nuevo `base.sql` con phpMyAdmin para crear **solo la tabla nueva `whatsapp_outbox`**. `CREATE TABLE IF NOT EXISTS` y `INSERT IGNORE` conservan los datos existentes de `registro`. Comprueba que el usuario MySQL tiene permiso `INSERT` además de `SELECT` y `UPDATE`.
2. Edita el archivo privado `/home/USUARIO/prestamos-config.php`: agrega `wasender_api_key` con la **clave API de la sesión existente** de WasenderAPI y cambia `whatsapp_auto_enabled` a `true`. No uses el token de otra plataforma ni coloques la clave en React o en `public_html`.
3. Sube `prestamos-whatsapp-cron.php` a `/home/USUARIO/`, junto a `prestamos-config.php`, **fuera de `public_html`**.
4. En cPanel → **Cron Jobs**, crea una tarea cada minuto (`* * * * *`) con este comando, ajustando el usuario y la ruta de PHP 8.2 o posterior de tu hosting:

   ```text
   /usr/local/bin/php -q /home/USUARIO/prestamos-whatsapp-cron.php
   ```

5. En la ficha de cada cliente que aceptó avisos, registra su celular peruano y marca **«El cliente autorizó recibir avisos…»**. Los clientes existentes empiezan sin esta marca. El sistema no manda mensajes automáticos a clientes sin teléfono válido o sin autorización.

Al crear un préstamo, se prepara un aviso y el cron lo envía en su siguiente ejecución. Al guardar un abono nuevo, se prepara un comprobante con el monto recibido, el saldo de la cuota parcialmente pagada (si corresponde) y el saldo total del préstamo. Para activar los comprobantes, actualiza tanto `index.php` como `/home/USUARIO/prestamos-whatsapp-cron.php`; la tarea programada y la tabla `whatsapp_outbox` existentes siguen sirviendo. Si editas o eliminas un abono antes de que salga el comprobante, el aviso pendiente se cancela. El día de vencimiento, el cron prepara un recordatorio de cada cuota aún pendiente a partir de las **9:00 a. m., hora de Lima**. No se repiten avisos para la misma cuota. Restaurar un respaldo no vuelve a generar mensajes de creación ni de abonos.

Puedes comprobar los resultados en `whatsapp_outbox` mediante phpMyAdmin: `accepted` significa que WasenderAPI aceptó la solicitud, no que WhatsApp confirmó la entrega. `failed`, `skipped` y `unknown` requieren revisión. El cron no reenvía automáticamente los casos `unknown` porque podrían haber salido aunque se perdiera la respuesta.

### Marcar en bloque a clientes que ya autorizaron los avisos

Si todos los clientes existentes ya aceptaron recibir mensajes, sube `prestamos-autorizar-clientes.php` a `/home/USUARIO/`, junto a la configuración privada. Desde **Terminal** de cPanel, revisa primero cuántas fichas cambiaría:

```sh
/usr/local/bin/php -q /home/USUARIO/prestamos-autorizar-clientes.php
```

Para aplicar el cambio una sola vez:

```sh
/usr/local/bin/php -q /home/USUARIO/prestamos-autorizar-clientes.php --apply
```

El script crea antes un respaldo privado `prestamos-antes-autorizacion-*.json`, actualiza el registro y aumenta su revisión para que las pestañas abiertas pidan recargar antes de guardar. No envía de nuevo avisos de creación de préstamos antiguos. Recarga la página después. Si algunos clientes no dieron permiso, márcalos individualmente desde **Clientes → Editar** en vez de ejecutar el cambio en bloque.
