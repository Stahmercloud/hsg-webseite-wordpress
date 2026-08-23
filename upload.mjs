// Laedt handball-data.json per FTPS (explicit TLS, Port 21) in die Mediathek der HSG-Seite.
import { Client } from 'basic-ftp';
const REMOTE_DIR = '/wp-content/uploads/hsg-1herren/assets';
const c = new Client(30000);
try {
  await c.access({
    host: process.env.FTP_HOST,
    user: process.env.FTP_USER,
    password: process.env.FTP_PASS,
    secure: true,
    secureOptions: { rejectUnauthorized: false },
  });
  await c.ensureDir(REMOTE_DIR);
  await c.uploadFrom('handball-data.json', 'handball-data.json');
  console.log('Upload OK ->', REMOTE_DIR + '/handball-data.json');
} catch (e) {
  console.error('Upload-Fehler:', e.message);
  process.exit(1);
} finally {
  c.close();
}
