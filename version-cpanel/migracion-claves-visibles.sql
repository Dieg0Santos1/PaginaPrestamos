-- Ejecutar una sola vez en phpMyAdmin si cliente_accesos ya existe.
-- Conserva los clientes, sus claves de acceso y todos los préstamos.
ALTER TABLE cliente_accesos ADD COLUMN clave_cifrada TEXT NULL;
