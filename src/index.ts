import 'dotenv/config';
import express from 'express';
import Database from 'better-sqlite3';
import { google } from 'googleapis';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';

const port = Number(process.env.PORT ?? 8088);
const app = express();
app.use(express.json());

const db = new Database(process.env.SQLITE_PATH ?? './data/app.db');
db.exec(`CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT)`);

type DriveFile = { id?: string | null; name?: string | null; mimeType?: string | null; size?: string | null; modifiedTime?: string | null; md5Checksum?: string | null };

function drive() {
  const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.drive({ version: 'v3', auth });
}

function naturalSort(a: DriveFile, b: DriveFile) {
  const number = (name: string) => Number(name.match(/(\d+)(?=\.[^.]+$)/)?.[1] ?? Number.MAX_SAFE_INTEGER);
  return number(a.name ?? '') - number(b.name ?? '') || (a.name ?? '').localeCompare(b.name ?? '', undefined, { numeric: true });
}

async function listInputFiles() {
  const folder = process.env.DRIVE_INPUT_FOLDER_ID;
  if (!folder) throw new Error('DRIVE_INPUT_FOLDER_ID is not configured');
  const result = await drive().files.list({
    q: `'${folder}' in parents and trashed = false`,
    fields: 'files(id,name,mimeType,size,modifiedTime,md5Checksum)',
    pageSize: 1000
  });
  return (result.data.files ?? []).filter(f => /\.(jpe?g|png)$/i.test(f.name ?? '')).sort(naturalSort);
}

app.get('/health', (_req, res) => res.json({ status: 'ok', port }));
app.get('/api/files', async (_req, res) => {
  try { res.json({ files: await listInputFiles() }); }
  catch (error) { res.status(500).json({ error: String(error) }); }
});

app.post('/api/jobs', async (_req, res) => {
  const id = `job-${Date.now()}`;
  const now = new Date().toISOString();
  db.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?, ?)').run(id, 'QUEUED', now, now, null);
  res.status(202).json({ id, status: 'QUEUED' });
  void runJob(id).catch(() => undefined);
});

app.get('/api/jobs/:id', (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  job ? res.json(job) : res.status(404).json({ error: 'Job not found' });
});

async function runJob(id: string) {
  const update = (status: string, error: string | null = null) => db.prepare('UPDATE jobs SET status=?, updated_at=?, error=? WHERE id=?').run(status, new Date().toISOString(), error, id);
  try {
    update('PROCESSING');
    const files = await listInputFiles();
    if (!files.length) throw new Error('No supported images in input folder');
    const pdf = await PDFDocument.create();
    for (const file of files) {
      if (!file.id) continue;
      const response = await drive().files.get({ fileId: file.id, alt: 'media' }, { responseType: 'arraybuffer' });
      const image = await sharp(Buffer.from(response.data as ArrayBuffer)).rotate().png().toBuffer({ resolveWithObject: true });
      const embedded = await pdf.embedPng(image.data);
      const page = pdf.addPage([595.28, 841.89]);
      const margin = 24;
      const scale = Math.min((page.getWidth() - 2 * margin) / embedded.width, (page.getHeight() - 2 * margin) / embedded.height);
      const width = embedded.width * scale, height = embedded.height * scale;
      page.drawImage(embedded, { x: (page.getWidth() - width) / 2, y: (page.getHeight() - height) / 2, width, height });
    }
    const out = await pdf.save();
    const folder = process.env.DRIVE_PDF_FOLDER_ID;
    if (!folder) throw new Error('DRIVE_PDF_FOLDER_ID is not configured');
    await drive().files.create({ requestBody: { name: `photos-${new Date().toISOString().replace(/[:.]/g, '-')}.pdf`, parents: [folder], mimeType: 'application/pdf' }, media: { mimeType: 'application/pdf', body: Buffer.from(out) } });
    update('PDF_UPLOADED');
    const archive = process.env.DRIVE_ARCHIVE_FOLDER_ID;
    if (archive) for (const file of files) if (file.id) await drive().files.update({ fileId: file.id, addParents: archive, removeParents: process.env.DRIVE_INPUT_FOLDER_ID });
    update('COMPLETED');
  } catch (error) { update('FAILED', String(error)); }
}

app.get('/', (_req, res) => res.send(`<!doctype html><meta charset="utf-8"><title>Photo to PDF</title><h1>Photo to PDF</h1><button id="refresh">사진 새로고침</button> <button id="run">변환 시작</button><ol id="files"></ol><pre id="status"></pre><script>const list=document.querySelector('#files'), status=document.querySelector('#status'); async function refresh(){const r=await fetch('/api/files'); const d=await r.json(); list.innerHTML=(d.files||[]).map(f=>'<li>'+f.name+'</li>').join('');} document.querySelector('#refresh').onclick=refresh; document.querySelector('#run').onclick=async()=>{const r=await fetch('/api/jobs',{method:'POST'}); const d=await r.json(); status.textContent='작업 시작: '+d.id;}; refresh();</script>`));

app.listen(port, process.env.HOST ?? '127.0.0.1', () => console.log(`Photo-to-PDF listening on ${process.env.HOST ?? '127.0.0.1'}:${port}`));
