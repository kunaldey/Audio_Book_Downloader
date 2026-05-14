const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const os = require('os');

const PORT = process.env.PORT || 3000;
const HTML_FILE = path.join(__dirname, 'index.html');

// Prevent any unhandled error from crashing the server process
process.on('uncaughtException', err => console.error('[uncaughtException]', err));
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));

let activeProc = null; // currently running download process

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(HTML_FILE).pipe(res);
    return;
  }

  if (req.method === 'GET' && req.url === '/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ defaultDownloadPath: process.env.DEFAULT_DOWNLOAD_PATH || '' }));
    return;
  }

  if (req.method === 'POST' && req.url === '/run-test') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let youtubeUrl, downloadPath;
      try {
        ({ youtubeUrl, downloadPath } = JSON.parse(body));
      } catch {
        res.writeHead(400);
        res.end('Invalid JSON');
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      let finished = false;
      const send = (type, message) => {
        if (finished) return;
        try { res.write(`data: ${JSON.stringify({ type, message })}\n\n`); } catch {}
      };
      const finish = () => {
        if (finished) return;
        finished = true;
        clearInterval(heartbeat);
        try { res.end(); } catch {}
      };

      // Keep the SSE connection alive every 25 s so the browser doesn't time it out
      const heartbeat = setInterval(() => {
        try { res.write(': keep-alive\n\n'); } catch { clearInterval(heartbeat); }
      }, 25000);

      send('info', `YouTube URL: ${youtubeUrl}\nDownload Path: ${downloadPath}\n${'─'.repeat(60)}\n`);

      const env = {
        ...process.env,
        YOUTUBE_URL: youtubeUrl,
        DOWNLOAD_PATH: downloadPath,
        PYTHONUNBUFFERED: '1',
      };

      const scriptPath = path.join(__dirname, 'download.py');

      try {
        activeProc = spawn('python', [scriptPath], { env, cwd: __dirname });
      } catch (spawnErr) {
        send('error', `Spawn failed: ${spawnErr.message}\n`);
        finish();
        return;
      }

      activeProc.on('error', err => {
        send('error', `Process error: ${err.message}\n`);
        activeProc = null;
        finish();
      });

      activeProc.stdout.on('data', d => send('log', d.toString()));
      activeProc.stderr.on('data', d => send('log', d.toString()));

      activeProc.on('close', (code, signal) => {
        activeProc = null;
        const ok = code === 0;
        let msg;
        if (code === null && signal) {
          msg = signal === 'SIGTERM' ? '⏹ Download stopped by user.' : `✗ Process killed by signal: ${signal}`;
        } else {
          msg = ok ? '✓ Download completed successfully!' : `✗ Download failed (exit code ${code})`;
        }
        send(ok || signal === 'SIGTERM' ? 'success' : 'error', `\n${'─'.repeat(60)}\n${msg}`);
        finish();
      });

      res.on('close', () => {
        if (!finished) {
          finish();
          if (activeProc && !activeProc.killed) { activeProc.kill(); activeProc = null; }
        }
      });
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/convert-thumbnails') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      let folderPath, apiKey, mode;
      try { ({ folderPath, apiKey, mode } = JSON.parse(body)); }
      catch { res.writeHead(400); res.end('Invalid JSON'); return; }

      const effectiveKey = apiKey || process.env.OPENAI_API_KEY;
      const useAI = mode === 'ai';

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      let finished = false;
      const send = d => { if (!finished) try { res.write(`data: ${JSON.stringify(d)}\n\n`); } catch {} };
      const finish = () => { if (!finished) { finished = true; try { res.end(); } catch {} } };
      res.on('close', () => { if (!finished) finish(); });

      if (useAI && !effectiveKey) {
        send({ type: 'error', message: 'No OpenAI API key provided.' });
        finish(); return;
      }

      let sharp, OpenAI, toFile;
      try {
        sharp = require('sharp');
        if (useAI) ({ OpenAI, toFile } = require('openai'));
      } catch {
        send({ type: 'error', message: 'Missing packages — run: npm install' });
        finish(); return;
      }

      try {
        const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];
        const SIZE = 1024;

        if (!fs.existsSync(folderPath)) {
          send({ type: 'error', message: 'Folder not found: ' + folderPath });
          finish(); return;
        }

        const files = fs.readdirSync(folderPath).filter(f => {
          const ext = path.extname(f).toLowerCase();
          return IMAGE_EXTS.includes(ext) && !f.toLowerCase().includes('-square');
        });

        if (!files.length) {
          send({ type: 'done', message: 'No images found to convert.', converted: 0, failed: 0, total: 0 });
          finish(); return;
        }

        const squareDir = path.join(folderPath, 'square');
        if (!fs.existsSync(squareDir)) fs.mkdirSync(squareDir);

        send({ type: 'start', total: files.length });

        let converted = 0, failed = 0;

        for (let i = 0; i < files.length; i++) {
          const filename = files[i];
          const inputPath = path.join(folderPath, filename);
          const outName   = path.parse(filename).name + '-square.png';
          const outPath   = path.join(squareDir, outName);

          send({ type: 'progress', current: i + 1, total: files.length, filename, status: 'processing' });

          try {
            const { width, height } = await sharp(inputPath).metadata();

            if (width === height) {
              fs.copyFileSync(inputPath, outPath);
              converted++;
              send({ type: 'progress', current: i + 1, total: files.length, filename, status: 'done', note: 'already square' });
              continue;
            }

            if (useAI) {
              // ── AI mode: gpt-image-1 outpainting ─────────────────────────
              const openai = new OpenAI({ apiKey: effectiveKey });
              const scale = Math.min(SIZE / width, SIZE / height);
              const sw  = Math.round(width * scale);
              const sh  = Math.round(height * scale);
              const lft = Math.floor((SIZE - sw) / 2);
              const top = Math.floor((SIZE - sh) / 2);

              const resized = await sharp(inputPath).resize(sw, sh).toBuffer();
              const padded  = await sharp({
                create: { width: SIZE, height: SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
              }).composite([{ input: resized, left: lft, top }]).png().toBuffer();

              const px = Buffer.alloc(SIZE * SIZE * 4);
              for (let y = 0; y < SIZE; y++) {
                for (let x = 0; x < SIZE; x++) {
                  const idx = (y * SIZE + x) * 4;
                  const inside = x >= lft && x < lft + sw && y >= top && y < top + sh;
                  px[idx] = px[idx + 1] = px[idx + 2] = 255;
                  px[idx + 3] = inside ? 255 : 0;
                }
              }
              const mask = await sharp(px, { raw: { width: SIZE, height: SIZE, channels: 4 } }).png().toBuffer();

              const resp = await openai.images.edit({
                model: 'gpt-image-1',
                image: await toFile(padded, 'image.png', { type: 'image/png' }),
                mask:  await toFile(mask,   'mask.png',  { type: 'image/png' }),
                prompt: 'Seamlessly extend the background to fill the empty transparent areas to make the image perfectly square. Match the colors, lighting, style, and atmosphere of the original.',
                n: 1, size: '1024x1024',
              });
              const imgData = resp.data[0];
              const imgBuffer = imgData.b64_json
                ? Buffer.from(imgData.b64_json, 'base64')
                : await fetch(imgData.url).then(r => r.arrayBuffer()).then(b => Buffer.from(b));
              fs.writeFileSync(outPath, imgBuffer);

            } else {
              // ── Local mode: centre-crop to square ────────────────────────
              const result = await sharp(inputPath)
                .resize(SIZE, SIZE, { fit: 'cover', position: 'centre' })
                .jpeg({ quality: 92 })
                .toBuffer();

              const outJpg = path.join(squareDir, path.parse(filename).name + '-square.jpg');
              fs.writeFileSync(outJpg, result);
            }

            converted++;
            send({ type: 'progress', current: i + 1, total: files.length, filename, status: 'done', outName });

          } catch (err) {
            failed++;
            send({ type: 'progress', current: i + 1, total: files.length, filename, status: 'error', error: err.message });
          }
        }

        send({ type: 'done', message: `Converted ${converted} of ${files.length} images`, converted, failed, total: files.length });
      } catch (err) {
        send({ type: 'error', message: err.message });
      }

      finish();
    });
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/browse-folder')) {
    const reqUrl  = new URL(req.url, `http://localhost:${PORT}`);
    const initial = reqUrl.searchParams.get('initial') || 'C:\\Users';
    const safeInitial = initial.replace(/'/g, "''"); // escape single quotes for PS

    const script = `
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'Select Download Folder'
$d.ShowNewFolderButton = $true
$p = '${safeInitial}'
if (Test-Path $p) { $d.SelectedPath = $p }
if ($d.ShowDialog() -eq 'OK') { Write-Output $d.SelectedPath }
`.trimStart();

    const scriptFile = path.join(os.tmpdir(), 'yt-folder-picker.ps1');
    fs.writeFileSync(scriptFile, script, 'utf8');

    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptFile],
      (err, stdout) => {
        const selected = stdout.trim();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ path: selected || null }));
      }
    );
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/list-files')) {
    const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
    const dirPath = reqUrl.searchParams.get('path');

    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });

    if (!dirPath) {
      res.end(JSON.stringify({ files: [], error: 'Missing path' }));
      return;
    }

    try {
      if (!fs.existsSync(dirPath)) {
        res.end(JSON.stringify({ files: [], error: 'Folder not found' }));
        return;
      }

      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const files = entries
        .filter(e => e.isFile())
        .map(e => {
          const stat = fs.statSync(path.join(dirPath, e.name));
          return {
            name: e.name,
            size: stat.size,
            modified: stat.mtime.toISOString(),
            ext: path.extname(e.name).toLowerCase(),
          };
        })
        .sort((a, b) => new Date(b.modified) - new Date(a.modified));

      res.end(JSON.stringify({ files }));
    } catch (err) {
      res.end(JSON.stringify({ files: [], error: err.message }));
    }
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/list-folders')) {
    const reqUrl  = new URL(req.url, `http://localhost:${PORT}`);
    const dirPath = reqUrl.searchParams.get('path') || '/nas';
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    try {
      if (!fs.existsSync(dirPath)) {
        res.end(JSON.stringify({ folders: [], error: 'Path not found: ' + dirPath })); return;
      }
      const folders = fs.readdirSync(dirPath, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .sort();
      res.end(JSON.stringify({ folders }));
    } catch (err) {
      res.end(JSON.stringify({ folders: [], error: err.message }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/rename-files') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let folderPath;
      try { ({ folderPath } = JSON.parse(body)); }
      catch { res.writeHead(400); res.end('Invalid JSON'); return; }

      res.writeHead(200, { 'Content-Type': 'application/json' });

      const VIDEO_EXTS = ['.webm', '.mp4', '.mkv', '.avi', '.mp3'];

      function cleanFilename(filename) {
        const ext  = path.extname(filename);
        let name   = path.basename(filename, ext);

        name = name.replace(/^vidssave\.com\s*/i, '');
        name = name.replace(/\s*\b\d+\s*kbps\b/gi, '').trim();

        // Format: Title By Author ｜ Narrators ｜ Show info
        // "By" appears before the first "｜" → extract title+author from the segment before ｜
        if (name.includes(' By ') && name.includes(' ｜ ')) {
          const pipeIdx = name.indexOf(' ｜ ');
          const byIdx   = name.indexOf(' By ');
          if (byIdx < pipeIdx) {
            const beforePipe = name.substring(0, pipeIdx).trim();
            const titlePart  = beforePipe.substring(0, byIdx).replace(/\s+/g, ' ').trim();
            const author     = beforePipe.substring(byIdx + 4).replace(/\s+/g, ' ').trim();
            return `${titlePart} - ${author}${ext}`;
          }
        }

        // Format: ShowName ｜ Title ｜ Author ｜ Description ...
        if (name.includes(' ｜ ')) {
          const parts  = name.split(' ｜ ').map(p => p.trim());
          const title  = parts[1] || '';
          const author = parts[2] || '';
          if (title && author) return `${title} - ${author}${ext}`;
          if (title)           return `${title}${ext}`;
          return parts[0] + ext;
        }

        // Format: #ShowName Ep XX _ Title _ Author _ Narrator
        if (name.includes(' _ ')) {
          const parts = name.split(' _ ').map(p => p.replace(/\s+/g, ' ').trim());
          // parts[0] = "#ShowName Ep XX", parts[1] = title, parts[2] = author
          const title  = parts[1] || '';
          const author = parts[2] || '';
          if (title && author) return `${title} - ${author}${ext}`;
          if (title)           return `${title}${ext}`;
        }

        // Format: Title By Author (no ｜)
        if (name.includes(' By ')) {
          const idx       = name.indexOf(' By ');
          const titlePart = name.substring(0, idx).replace(/\s+/g, ' ').trim();
          const remaining = name.substring(idx + 4);
          const author    = remaining.split('_')[0].replace(/\s+/g, ' ').trim();
          return `${titlePart} - ${author}${ext}`;
        }

        return name.replace(/\s+/g, ' ').trim() + ext;
      }

      try {
        if (!fs.existsSync(folderPath)) {
          res.end(JSON.stringify({ error: 'Folder not found', renamed: [] }));
          return;
        }

        const results = [];
        for (const entry of fs.readdirSync(folderPath, { withFileTypes: true })) {
          if (!entry.isFile()) continue;
          if (!VIDEO_EXTS.includes(path.extname(entry.name).toLowerCase())) continue;

          const newName = cleanFilename(entry.name);
          if (newName === entry.name) continue;

          const oldPath = path.join(folderPath, entry.name);
          const newPath = path.join(folderPath, newName);
          try {
            fs.renameSync(oldPath, newPath);
            results.push({ old: entry.name, new: newName, status: 'ok' });
          } catch (err) {
            results.push({ old: entry.name, new: newName, status: 'error', error: err.message });
          }
        }

        res.end(JSON.stringify({ renamed: results, total: results.length }));
      } catch (err) {
        res.end(JSON.stringify({ error: err.message, renamed: [] }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/copy-files') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let sourcePath, destPath, files;
      try { ({ sourcePath, destPath, files } = JSON.parse(body)); }
      catch { res.writeHead(400); res.end('Invalid JSON'); return; }

      res.writeHead(200, { 'Content-Type': 'application/json' });

      try {
        if (!fs.existsSync(sourcePath)) {
          res.end(JSON.stringify({ error: 'Source folder not found' })); return;
        }
        if (!fs.existsSync(destPath)) {
          try { fs.mkdirSync(destPath, { recursive: true }); }
          catch { res.end(JSON.stringify({ error: 'Cannot create destination folder: ' + destPath })); return; }
        }

        let moved = 0;
        const errors = [];
        for (const filename of files) {
          const src  = path.join(sourcePath, filename);
          const dest = path.join(destPath, filename);
          try {
            fs.copyFileSync(src, dest);
            fs.unlinkSync(src); // delete source after successful copy
            moved++;
          } catch (err) {
            errors.push({ file: filename, error: err.message });
          }
        }

        res.end(JSON.stringify({ moved, total: files.length, errors }));
      } catch (err) {
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/rename-file') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let folderPath, oldName, newName;
      try { ({ folderPath, oldName, newName } = JSON.parse(body)); }
      catch { res.writeHead(400); res.end('Invalid JSON'); return; }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      try {
        const oldPath = path.join(folderPath, oldName);
        const newPath = path.join(folderPath, newName);
        if (!fs.existsSync(oldPath)) {
          res.end(JSON.stringify({ error: 'File not found' })); return;
        }
        if (fs.existsSync(newPath)) {
          res.end(JSON.stringify({ error: 'A file with that name already exists' })); return;
        }
        fs.renameSync(oldPath, newPath);
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/delete-files') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let folderPath, files;
      try { ({ folderPath, files } = JSON.parse(body)); }
      catch { res.writeHead(400); res.end('Invalid JSON'); return; }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      try {
        let deleted = 0;
        const errors = [];
        for (const filename of files) {
          const filePath = path.join(folderPath, filename);
          try {
            fs.unlinkSync(filePath);
            deleted++;
          } catch (err) {
            errors.push({ file: filename, error: err.message });
          }
        }
        res.end(JSON.stringify({ deleted, total: files.length, errors }));
      } catch (err) {
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/stop') {
    if (activeProc && !activeProc.killed) {
      activeProc.kill();
      activeProc = null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ stopped: true }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ stopped: false, reason: 'No active process' }));
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\nServer running → http://localhost:${PORT}\n`);
});
