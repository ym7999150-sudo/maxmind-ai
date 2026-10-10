// ============================================================================
// MuxMind AI — src/file-parser.js
// Multi-Modal Upload Handler (PDF, JS, CSS, Base64, Images)
// ============================================================================

const fs = require("fs");
const path = require("path");
const pdfParse = require("pdf-parse");

const TEXT_EXTENSIONS = [".js", ".css", ".html", ".py", ".txt", ".json", ".md"];
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"];

async function parseUploadedFile(file) {
  const ext = path.extname(file.originalname).toLowerCase();

  try {
    if (ext === ".pdf") {
      const buffer = fs.readFileSync(file.path);
      const parsed = await pdfParse(buffer);
      return {
        type: "pdf",
        filename: file.originalname,
        content: parsed.text.slice(0, 50000), // safety cap
        pages: parsed.numpages,
      };
    }

    if (TEXT_EXTENSIONS.includes(ext)) {
      const content = fs.readFileSync(file.path, "utf-8");
      return {
        type: "text",
        filename: file.originalname,
        language: ext.replace(".", ""),
        content: content.slice(0, 50000),
      };
    }

    if (IMAGE_EXTENSIONS.includes(ext)) {
      const buffer = fs.readFileSync(file.path);
      const base64 = buffer.toString("base64");
      const mime = `image/${ext.replace(".", "").replace("jpg", "jpeg")}`;
      return {
        type: "image",
        filename: file.originalname,
        mime,
        base64,
      };
    }

    return {
      type: "unsupported",
      filename: file.originalname,
      error: `Unsupported file type: ${ext}`,
    };
  } finally {
    // cleanup temp upload
    fs.unlink(file.path, () => {});
  }
}

module.exports = { parseUploadedFile, TEXT_EXTENSIONS, IMAGE_EXTENSIONS };
