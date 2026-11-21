# Instalar Mis préstamos en cPanel

Requisitos de la versión web: PHP 8.2 o posterior, extensión pdo_mysql, MySQL o MariaDB y HTTPS.

1. Desde la versión local, descarga la copia JSON en Respaldo.
2. En cPanel, crea una base y un usuario en Database Wizard. La aplicación necesita SELECT y UPDATE. Abre phpMyAdmin, selecciona la base e importa base.sql.
3. En cPanel → Dominios, crea prestamos.dadtvplay.com con una raíz propia en public_html/prestamos. Sube index.php a esa raíz. Haz una copia de prestamos-config.example.php con el nombre prestamos-config.php y súbela al directorio de inicio de la cuenta, junto a public_html y fuera de la raíz pública. La ruta de configuración en index.php supone esta estructura. Si eliges otra raíz, ajusta esa ruta antes de publicar.
4. Edita el archivo privado con el nombre completo de la base, usuario y contraseña de MySQL. En login_user coloca tu usuario de acceso y en login_password una contraseña única de al menos 12 caracteres. Mantén este archivo fuera de public_html y limita sus permisos de lectura a los necesarios para PHP. Si ya usabas la versión con access_key, reemplaza esa entrada por login_user y login_password antes de subir el nuevo index.php.
5. Activa el certificado SSL y la redirección HTTPS para el subdominio. Entra a https://prestamos.dadtvplay.com/ con tu usuario y contraseña. Importa el JSON una vez desde Respaldo. Restaurar reemplaza el registro compartido.
6. Abre la misma dirección desde el celular con datos móviles. Los cambios aparecen en el otro dispositivo al volver a abrir o recargar. Si dos dispositivos guardan sobre la misma versión, el segundo debe actualizar antes de reintentar.

Solo index.php va en la carpeta pública. Guarda el respaldo y la configuración fuera de ella. Después de importar, usa la versión del dominio para trabajar con el registro compartido.

