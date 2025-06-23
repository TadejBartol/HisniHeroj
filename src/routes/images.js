// =============================================================================
// Image Serving Routes
// =============================================================================

const express = require('express');
const path = require('path');
const fs = require('fs').promises;

const router = express.Router();

// =============================================================================
// GET /images/:filename - Serve Images
// =============================================================================

router.get('/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    const uploadDir = process.env.UPLOAD_DIR || '/share/hisniheroj/uploads';
    
    // Security: prevent directory traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_FILENAME',
          message: 'Neveljavno ime datoteke'
        }
      });
    }

    const filePath = path.join(uploadDir, filename);
    
    // Check if file exists
    try {
      await fs.access(filePath);
    } catch (error) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'IMAGE_NOT_FOUND',
          message: 'Slika ni najdena'
        }
      });
    }

    // Set appropriate headers
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp'
    };

    const mimeType = mimeTypes[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 1 day

    // Send file
    res.sendFile(filePath);

  } catch (error) {
    console.error('Serve image error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'SERVE_IMAGE_ERROR',
        message: 'Napaka pri pridobivanju slike'
      }
    });
  }
});

module.exports = router; 