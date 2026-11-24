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

### Publicar sin ZIP desde GitHub

Si cPanel muestra **Git Version Control**, clona `https://github.com/Dieg0Santos1/PaginaPrestamos.git` en una carpeta del usuario **fuera de `public_html`**. El archivo `.cpanel.yml` de este repositorio copia solo los archivos públicos a `$HOME/public_html/prestamos`. Comprueba primero que esa es la raíz real del subdominio y cambia `DEPLOYPATH` en `.cpanel.yml` si no coincide. En cPanel, abre el repositorio, pulsa **Update from Remote** y luego **Deploy HEAD Commit**. Las siguientes versiones usan esos mismos dos botones; no hace falta subir ZIP.

Esta opción depende de que tu proveedor tenga habilitada la función Git Version Control. No ejecuta cambios de base de datos ni modifica el archivo privado `prestamos-config.php`.

1. En `PaginaPrestamos/react-app`, ejecuta `npm.cmd run build`. Esto genera `../version-cpanel/react-dist/manifest.json` y los archivos de `react-dist/assets/`. La compilación elimina el HTML de Vite para que la entrada pública siga siendo `index.php`.
2. En cPanel, comprueba que el subdominio `prestamos.dadtvplay.com` tiene raíz propia en `public_html/prestamos` y HTTPS activo.
3. En esa raíz, reemplaza `index.php` y sube `cliente.php`, `clientes-admin.php` y la carpeta **`react-dist` completa**. La estructura debe ser:

   También puedes subir `../prestamos-react-clientes-cpanel.zip` a esa raíz y extraerlo allí; contiene exactamente esos archivos.

   ```text
   /home/usuario/
   ├── prestamos-config.php
   └── public_html/prestamos/
       ├── index.php
       ├── cliente.php
       ├── clientes-admin.php
       └── react-dist/
           ├── manifest.json
           └── assets/
               ├── index-....js
               └── index-....css
   ```

4. Mantén `prestamos-config.php` fuera de `public_html`. Copia `prestamos-config.example.php` como punto de partida y coloca allí los datos de MySQL, `login_user` y una `login_password` de al menos 12 caracteres. **No subas el archivo de ejemplo con valores reales.**
5. Si todavía no existe la tabla, importa `base.sql` en la base mediante phpMyAdmin. El usuario MySQL necesita `SELECT`, `UPDATE` e `INSERT` para el funcionamiento normal con avisos automáticos.
6. Abre `https://prestamos.dadtvplay.com/`, inicia sesión y recarga con Ctrl + F5. Los registros que ya están en MySQL se muestran sin volver a importar el respaldo.

Al actualizar la interfaz, repite la compilación y reemplaza `index.php`, `cliente.php`, `clientes-admin.php` y `react-dist`. No importes de nuevo un respaldo a menos que quieras reemplazar el registro compartido. El código fuente `react-app`, `node_modules` y el JSON de respaldo no se suben a la carpeta pública.

## Portal de clientes y capturas de Yape

1. Si las tablas del portal aún no existen, importa `base.sql` en phpMyAdmin. Si ya existen, **no hay que cambiar la estructura de la base de datos**. El usuario de MySQL necesita `SELECT`, `INSERT`, `UPDATE` y `DELETE` sobre `cliente_accesos`, y `SELECT`, `INSERT` y `UPDATE` sobre `comprobantes_yape`. Comprueba que PHP tiene la extensión `fileinfo` y que los límites de subida permiten archivos de hasta 4 MB.
2. Sube `cliente.php` y `clientes-admin.php` junto a `index.php` en la raíz del subdominio. La carpeta `react-dist` debe contener la compilación nueva. Los comprobantes se almacenan en MySQL, no en una carpeta pública.
3. En **Clientes → Nuevo cliente**, escribe un DNI distinto de ocho dígitos y una contraseña de al menos ocho caracteres en la sección de acceso, debajo de los datos de contacto. Al guardar, la clave aparece en la tabla, en la ficha al editar y en una ventana para copiarla. Para cambiarla, escribe otra en el formulario. Los accesos anteriores solo guardaban un hash y mostrarán «Clave anterior» hasta que les asignes una contraseña nueva.
4. El cliente entra a `https://prestamos.dadtvplay.com/cliente.php` con su DNI y su clave. Puede ver únicamente los préstamos vinculados a su ficha y enviar una captura JPG, PNG o WebP de hasta 4 MB, indicando el préstamo y el monto enviado.
5. En **Comprobantes**, revisa la captura y confirma el ingreso en Yape. Puedes analizarla con IA o registrar el pago manualmente desde la misma pantalla; ambos caminos muestran una confirmación antes de crear el abono.

### Envío de acceso al guardar clientes

La ficha requiere un celular peruano válido. En el hosting también requiere DNI de ocho dígitos, clave de acceso y la autorización del cliente para recibir mensajes por WhatsApp. Al guardar un cliente nuevo o editar su ficha, `index.php` coloca en `whatsapp_outbox` un aviso de acceso. El cron actualizado envía al celular el DNI como usuario, la clave vigente y `https://prestamos.dadtvplay.com/cliente.php`. El aviso se prepara en la misma transacción que guarda la ficha y sale en la siguiente ejecución del cron. Si la clave antigua solo estaba guardada como hash, asigna una nueva en el formulario antes de guardar.

Para esta función publica `index.php` y la carpeta `react-dist` de la versión nueva y reemplaza también `/home/USUARIO/prestamos-whatsapp-cron.php`. No hace falta modificar las tablas existentes. La clave se descifra únicamente al enviar; `whatsapp_outbox.message_text` queda vacío para este tipo de aviso. El mensaje con la clave sí queda en el chat de WhatsApp del cliente, por lo que debe conservar su teléfono y su cuenta protegidos.

### Lectura de vouchers con IA

En el archivo privado `/home/USUARIO/prestamos-config.php`, añade `'openai_api_key'=>'TU_CLAVE_API'` (sin publicarla ni subirla a GitHub). Opcionalmente puedes definir `'openai_voucher_model'=>'gpt-6.1-terra'`. PHP necesita la extensión cURL y salida HTTPS hacia `api.openai.com`. Cada clic en **Analizar voucher** hace una llamada a la API de OpenAI y puede generar un cargo según el uso de tu cuenta.

La IA extrae monto, remitente, destinatario, fecha, hora y código visibles. En **Comprobantes**, revisa esos datos junto a la imagen. Confirma el ingreso en los Movimientos de tu propia cuenta Yape, corrige el monto o la fecha si hace falta y pulsa **Confirmar ingreso y registrar abono**. El sistema registra el abono y marca la captura como verificada en una sola operación; impide usar dos veces el mismo comprobante y avisa si el número de operación ya aparece en otro abono.

La captura y la lectura de IA no comprueban que el dinero llegó. Si no configuras la API, puedes usar **Registrar manualmente** tras verificar el movimiento en Yape.

No publiques un respaldo JSON de clientes ni guardes las contraseñas de acceso en el repositorio. Para iniciar sesión se usa un hash en `cliente_accesos`; para mostrarlas al administrador se guarda una copia cifrada en la ficha del cliente dentro de `registro`. Los respaldos JSON incluyen esa copia cifrada y deben mantenerse privados. El cifrado depende de la contraseña de MySQL del archivo privado `prestamos-config.php`; si se cambia, las claves anteriores dejarán de poder mostrarse, aunque los clientes podrán seguir ingresando con su hash. La página local de Vite no tiene acceso al portal PHP.

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

Al crear un préstamo, se prepara un aviso y el cron lo envía en su siguiente ejecución. Al guardar un abono nuevo desde **Pagos** o al confirmar un comprobante de Yape, se prepara un mensaje con el monto y la fecha recibidos, cada cuota que falta por pagar con su saldo y el saldo total del préstamo. Para activar estos avisos, actualiza `index.php`, `clientes-admin.php` y el archivo privado `/home/USUARIO/prestamos-whatsapp-cron.php`. La tarea programada y la tabla `whatsapp_outbox` existentes siguen sirviendo. Si editas o eliminas un abono antes de que salga el comprobante, el aviso pendiente se cancela. El día de vencimiento, el cron prepara un recordatorio de cada cuota aún pendiente a partir de las **9:00 a. m., hora de Lima**. No se repiten avisos para la misma cuota. Restaurar un respaldo no vuelve a generar mensajes de creación ni de abonos.

Si el cron antiguo dejó avisos de pago con estado `failed` y error `Tipo de aviso inválido`, reemplaza primero el archivo del cron. Después puedes reactivar solo el aviso más reciente desde phpMyAdmin, dentro de la base de préstamos: `UPDATE whatsapp_outbox SET status='pending', next_attempt_at=NOW(), last_error=NULL, claimed_at=NULL WHERE kind='payment' AND status='failed' AND last_error='Tipo de aviso inválido' ORDER BY id DESC LIMIT 1;`. El aviso falló antes de llegar a WasenderAPI y el cron actualizado lo procesará en su siguiente ejecución. Revisa los abonos anteriores antes de reactivar avisos más antiguos.

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
