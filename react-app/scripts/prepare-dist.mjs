import {unlinkSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

// La entrada pública es index.php: evita una página HTML que omita ese inicio de sesión.
unlinkSync(fileURLToPath(new URL('../../version-cpanel/react-dist/index.html', import.meta.url)));
