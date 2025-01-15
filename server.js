import express from 'express';
import cors from 'cors';
import WebTorrent from 'webtorrent';
import axios from 'axios';

const app = express();
app.use(cors());
app.use(express.json());

function extractDriveFileId(link) {
  const match = link.match(/\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

const client = new WebTorrent();
const activeTorrents = new Map();

console.log("Starting the unified streaming server...");

const server = app.listen(process.env.PORT || 3000, () => {
  console.log(`Server is running on http://localhost:${server.address().port}`);
});
server.setTimeout(0);

// Unified API for streaming files
app.post('/stream', async (req, res) => {
  const { link } = req.body;

  if (!link) {
    return res.status(400).json({ error: 'A valid link is required' });
  }

  try {
    if (link.startsWith('magnet:')) {
      console.log('Detected torrent magnet link');

      let torrent = activeTorrents.get(link);

      if (!torrent) {
        torrent = client.add(link);
        activeTorrents.set(link, torrent);

        const removeTorrent = () => {
          activeTorrents.delete(link);
          console.log(`Removed torrent: ${torrent.name}`);
        };

        torrent.on('done', () => {
          console.log(`Torrent download finished: ${torrent.name}`);
        });

        torrent.on('error', (err) => {
          console.error('Torrent error:', err.message);
          removeTorrent();
        });
      }

      const timeout = setTimeout(() => {
        if (!res.headersSent) {
          torrent.destroy();
          activeTorrents.delete(link);
          res.status(500).json({ error: 'Torrent loading timed out. Please try again.' });
        }
      }, 30000);

      let responseSent = false;

      if (!torrent.ready) {
        torrent.once('ready', () => {
          try {
            if (responseSent) return;
            responseSent = true;
            clearTimeout(timeout);
            console.log(`Torrent ready: ${torrent.name}`);

            const file = torrent.files.find((file) => file.name.endsWith('.mp4'));
            if (!file) {
              console.error('No MP4 file found in the torrent');
              return res.status(400).json({ error: 'No MP4 file found in the torrent' });
            }

            console.log(`Found MP4 file: ${file.name}`);
            const streamUrl = `http://localhost:${server.address().port}/stream/torrent/${encodeURIComponent(file.name)}`;
            res.json({ streamUrl });
          } catch (error) {
            console.error('Error handling torrent ready event:', error.message);
            res.status(500).json({ error: 'Failed to process the torrent.' });
          }
        });

        torrent.once('error', (err) => {
          if (responseSent) return;
          responseSent = true;
          console.error('Torrent error:', err.message);
          clearTimeout(timeout);
          res.status(500).json({ error: 'Failed to process the torrent.' });
        });
      } else {
        try {
          const file = torrent.files.find((file) => file.name.endsWith('.mp4'));
          if (!file) {
            console.error('No MP4 file found in the torrent');
            return res.status(400).json({ error: 'No MP4 file found in the torrent' });
          }

          console.log(`Found MP4 file: ${file.name}`);
          const streamUrl = `http://localhost:${server.address().port}/stream/torrent/${encodeURIComponent(file.name)}`;
          res.json({ streamUrl });

          clearTimeout(timeout);
          responseSent = true;
        } catch (error) {
          console.error('Error handling torrent response:', error.message);
          res.status(500).json({ error: 'Failed to process the torrent.' });
        }
      }
    } else {
      res.status(400).json({ error: 'Unsupported link type. Only magnet links are supported.' });
    }
  } catch (error) {
    console.error('Error processing the link:', error.message);
    res.status(500).json({ error: 'Failed to process the link.' });
  }
});

app.get('/stream', async (req, res) => {
  const link = req.query.link;

  if (!link) {
    return res.status(400).json({ error: 'A valid link is required' });
  }

  try {
    if (link.includes('drive.google.com')) {
      const fileId = extractDriveFileId(link);

      if (!fileId) {
        return res.status(400).json({ error: 'Invalid Google Drive link' });
      }

      const directUrl = `https://drive.google.com/uc?id=${fileId}&export=download`;

      const response = await axios({
        url: directUrl,
        method: 'GET',
        responseType: 'stream',
      });

      res.setHeader('Content-Type', response.headers['content-type']);
      res.setHeader('Content-Disposition', 'inline');
      response.data.pipe(res);
    } else {
      res.status(400).json({ error: 'Unsupported link type' });
    }
  } catch (error) {
    console.error('Error processing the link:', error.message);
    res.status(500).json({ error: 'Failed to stream the file.' });
  }
});

app.get('/stream/torrent/:filename', (req, res) => {
  try {
    const { filename } = req.params;

    const torrent = client.torrents.find((torrent) =>
      torrent.files.some((file) => file.name === filename)
    );

    if (!torrent) {
      return res.status(404).send('File not found.');
    }

    const file = torrent.files.find((file) => file.name === filename);
    const range = req.headers.range;
    const fileSize = file.length;

    if (!range) {
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Length', fileSize);

      const stream = file.createReadStream();

      stream.on('error', (err) => {
        console.error('Streaming error:', err.message);
        if (!res.headersSent) res.status(500).send('Failed to stream the file.');
      });

      req.on('close', () => {
        stream.destroy();
        console.log('Client disconnected, stream destroyed.');
      });

      stream.pipe(res);
      return;
    }

    const positions = range.replace(/bytes=/, '').split('-');
    const start = parseInt(positions[0], 10);
    const end = positions[1] ? parseInt(positions[1], 10) : fileSize - 1;

    const chunkSize = end - start + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/mp4',
    });

    const stream = file.createReadStream({ start, end });

    stream.on('error', (err) => {
      console.error('Streaming error:', err.message);
      if (!res.headersSent) res.status(500).send('Failed to stream the file.');
    });

    req.on('close', () => {
      stream.destroy();
      console.log('Client disconnected, stream destroyed.');
    });

    stream.pipe(res);
  } catch (error) {
    console.error('Error handling torrent streaming:', error.message);
    res.status(500).send('Failed to handle the torrent streaming.');
  }
});
