import { randomUUID, X509Certificate, createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import selfsigned from 'selfsigned';

export type Identity = { peerId: string; name: string; key: string; cert: string; fingerprint: string };

export async function loadIdentity(dataDir: string, name: string): Promise<Identity> {
  const identityDir = join(dataDir, 'identity');
  mkdirSync(identityDir, { recursive: true });
  const keyPath = join(identityDir, 'private.pem');
  const certPath = join(identityDir, 'certificate.pem');
  const idPath = join(identityDir, 'peer-id');
  if (!existsSync(keyPath) || !existsSync(certPath) || !existsSync(idPath)) {
    const pair = await selfsigned.generate([{ name: 'commonName', value: 'LAN Chat Peer' }], { keySize: 2048, days: 3650, algorithm: 'sha256' });
    writeFileSync(keyPath, pair.private, { mode: 0o600 });
    writeFileSync(certPath, pair.cert, { mode: 0o600 });
    writeFileSync(idPath, randomUUID(), { mode: 0o600 });
  }
  if (process.platform !== 'win32') {
    chmodSync(identityDir, 0o700);
    chmodSync(keyPath, 0o600);
    chmodSync(certPath, 0o600);
    chmodSync(idPath, 0o600);
  }
  const key = readFileSync(keyPath, 'utf8');
  const cert = readFileSync(certPath, 'utf8');
  const fingerprint = createHash('sha256').update(new X509Certificate(cert).raw).digest('hex');
  return { peerId: readFileSync(idPath, 'utf8').trim(), name, key, cert, fingerprint };
}
