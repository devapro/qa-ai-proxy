import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import mockttp from 'mockttp';

const CA_COMMON_NAME = 'QA Proxy CA';

export async function loadOrCreateCa(dir) {
    const keyPath = path.join(dir, 'ca.key.pem');
    const certPath = path.join(dir, 'ca.cert.pem');
    try {
        return { key: await readFile(keyPath, 'utf8'), cert: await readFile(certPath, 'utf8') };
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    const ca = await mockttp.generateCACertificate({ subject: { commonName: CA_COMMON_NAME } });
    await mkdir(dir, { recursive: true });
    await writeFile(keyPath, ca.key, { mode: 0o600 });
    await writeFile(certPath, ca.cert);
    return ca;
}
