// =============================================================================
// File Upload Utility
// =============================================================================

const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');

const UPLOAD_DIR = process.env.UPLOAD_DIR || '/share/hisniheroj/uploads';

// =============================================================================
// MULTER CONFIGURATION
// =============================================================================

const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  // Allow only image files
  if (file.mimetype.startsWith('image/')) {
    cb(null, true);
  } else {
    cb(new Error('Only image files are allowed'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: parseInt(process.env.UPLOAD_MAX_SIZE) || 10 * 1024 * 1024 // 10MB
  }
});

// =============================================================================
// IMAGE PROCESSING FUNCTIONS
// =============================================================================

/**
 * Process and save uploaded image
 */
async function processAndSaveImage(file, type, relatedId) {
  try {
    const timestamp = Date.now();
    const uuid = uuidv4().split('-')[0];
    const filename = `${type}_${relatedId}_${uuid}_${timestamp}`;
    
    // Create directories if they don't exist
    await ensureDirectories();
    
    const paths = {
      original: path.join(UPLOAD_DIR, 'original', `${filename}.jpg`),
      compressed: path.join(UPLOAD_DIR, 'compressed', `${filename}.jpg`),
      thumbnail: path.join(UPLOAD_DIR, 'thumbnails', `${filename}.jpg`)
    };

    // Process original image
    await sharp(file.buffer)
      .jpeg({ quality: 95, mozjpeg: true })
      .toFile(paths.original);

    // Create compressed version
    await sharp(file.buffer)
      .resize(800, 600, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .jpeg({ quality: 80, mozjpeg: true })
      .toFile(paths.compressed);

    // Create thumbnail
    await sharp(file.buffer)
      .resize(150, 150, {
        fit: 'cover',
        position: 'center'
      })
      .jpeg({ quality: 70, mozjpeg: true })
      .toFile(paths.thumbnail);

    // Get file stats
    const stats = await fs.stat(paths.compressed);

    return {
      filename: `${filename}.jpg`,
      original_path: paths.original,
      compressed_path: paths.compressed,
      thumbnail_path: paths.thumbnail,
      file_size: stats.size,
      mime_type: 'image/jpeg'
    };

  } catch (error) {
    throw new Error(`Error processing image: ${error.message}`);
  }
}

/**
 * Delete image files
 */
async function deleteImageFiles(filename) {
  try {
    const baseName = filename.replace('.jpg', '');
    
    const paths = [
      path.join(UPLOAD_DIR, 'original', filename),
      path.join(UPLOAD_DIR, 'compressed', filename),
      path.join(UPLOAD_DIR, 'thumbnails', filename)
    ];

    await Promise.allSettled(
      paths.map(filePath => fs.unlink(filePath))
    );

  } catch (error) {
    console.error('Error deleting image files:', error);
  }
}

/**
 * Ensure upload directories exist
 */
async function ensureDirectories() {
  const directories = [
    path.join(UPLOAD_DIR, 'original'),
    path.join(UPLOAD_DIR, 'compressed'),
    path.join(UPLOAD_DIR, 'thumbnails')
  ];

  for (const dir of directories) {
    try {
      await fs.access(dir);
    } catch (error) {
      await fs.mkdir(dir, { recursive: true });
    }
  }
}

/**
 * Get image file path based on type
 */
function getImagePath(filename, imageType = 'compressed') {
  return path.join(UPLOAD_DIR, imageType, filename);
}

/**
 * Check if image file exists
 */
async function imageExists(filename, imageType = 'compressed') {
  try {
    const filePath = getImagePath(filename, imageType);
    await fs.access(filePath);
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Get image metadata
 */
async function getImageMetadata(filename, imageType = 'compressed') {
  try {
    const filePath = getImagePath(filename, imageType);
    const stats = await fs.stat(filePath);
    const metadata = await sharp(filePath).metadata();
    
    return {
      size: stats.size,
      width: metadata.width,
      height: metadata.height,
      format: metadata.format,
      lastModified: stats.mtime
    };
  } catch (error) {
    throw new Error(`Error getting image metadata: ${error.message}`);
  }
}

/**
 * Clean up old images (for maintenance)
 */
async function cleanupOldImages(daysOld = 30) {
  try {
    const directories = ['original', 'compressed', 'thumbnails'];
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);

    for (const dir of directories) {
      const dirPath = path.join(UPLOAD_DIR, dir);
      const files = await fs.readdir(dirPath);

      for (const file of files) {
        const filePath = path.join(dirPath, file);
        const stats = await fs.stat(filePath);

        if (stats.mtime < cutoffDate) {
          await fs.unlink(filePath);
          console.log(`Deleted old image: ${filePath}`);
        }
      }
    }
  } catch (error) {
    console.error('Error during image cleanup:', error);
  }
}

// =============================================================================
// MIDDLEWARE
// =============================================================================

/**
 * Single image upload middleware
 */
const uploadSingle = (fieldName) => upload.single(fieldName);

/**
 * Multiple images upload middleware
 */
const uploadMultiple = (fieldName, maxCount = 5) => upload.array(fieldName, maxCount);

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  upload,
  uploadSingle,
  uploadMultiple,
  processAndSaveImage,
  deleteImageFiles,
  getImagePath,
  imageExists,
  getImageMetadata,
  cleanupOldImages,
  ensureDirectories
}; 