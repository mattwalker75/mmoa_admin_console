// public/js/image-upload.js — shrink a photo in the browser, then upload it.
//
// Contract (shared with the web app's nonprofit portal): before an image
// leaves the browser it is redrawn on a <canvas> at most 1600 px on its long
// edge and re-encoded as JPEG at quality ~0.82. Phone photos (4000 px,
// 5–10 MB) become ~200–400 KB, which matters most in EC2 access mode where
// every ~30 KB of the upload is one SSM command. Re-encoding also drops EXIF
// metadata (GPS location) from what is published. If the browser can't decode
// the file (e.g. HEIC on some browsers), the original is sent and the server
// decides (JPEG / PNG / WebP by magic bytes, 8 MB max).
//
// External file (not inline) because the CSP has no 'unsafe-inline'.
//
//   window.macResizeImage(file, opts?)          → Promise<Blob|File>
//   window.macUploadImage(url, file, fields?)   → Promise<{ ok, error?, message? }>
(function () {
  'use strict';

  var MAX_EDGE = 1600;
  var QUALITY = 0.82;

  function decode(file) {
    if (window.createImageBitmap) {
      // imageOrientation 'from-image' applies the EXIF rotation, so portrait
      // phone photos don't come out sideways.
      return window.createImageBitmap(file, { imageOrientation: 'from-image' })
        .catch(function () { return window.createImageBitmap(file); })
        .catch(function () { return decodeWithImg(file); });
    }
    return decodeWithImg(file);
  }

  function decodeWithImg(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Could not read that image.')); };
      img.src = url;
    });
  }

  window.macResizeImage = function (file, opts) {
    opts = opts || {};
    var maxEdge = opts.maxEdge || MAX_EDGE;
    var quality = opts.quality || QUALITY;
    if (!file || !/^image\//.test(file.type || '')) return Promise.resolve(file);
    return decode(file).then(function (src) {
      var w = src.width, h = src.height;
      if (!w || !h) return file;
      var scale = Math.min(1, maxEdge / Math.max(w, h));
      var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
      var canvas = document.createElement('canvas');
      canvas.width = cw; canvas.height = ch;
      var ctx = canvas.getContext('2d');
      // JPEG has no transparency: paint white under PNG/WebP alpha instead of black.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(src, 0, 0, cw, ch);
      if (src.close) { try { src.close(); } catch (e) { /* ignore */ } }
      return new Promise(function (resolve) {
        canvas.toBlob(function (blob) { resolve(blob || file); }, 'image/jpeg', quality);
      });
    }).catch(function () { return file; });
  };

  window.macUploadImage = function (url, file, fields) {
    if (!file) return Promise.resolve({ ok: false, error: 'Choose an image first.' });
    return window.macResizeImage(file).then(function (blob) {
      var fd = new FormData();
      var name = (file.name || 'image').replace(/\.[^.]+$/, '') + (blob && blob.type === 'image/jpeg' ? '.jpg' : '');
      fd.append('image', blob, name || 'image.jpg');
      if (fields) {
        Object.keys(fields).forEach(function (k) {
          if (fields[k] != null) fd.append(k, String(fields[k]));
        });
      }
      return fetch(url, { method: 'POST', body: fd, headers: { 'Accept': 'application/json' } })
        .then(function (r) {
          return r.json().catch(function () { return { ok: false, error: 'Upload failed (HTTP ' + r.status + ')' }; });
        })
        .catch(function (e) { return { ok: false, error: 'Network error: ' + (e && e.message || e) }; });
    });
  };
})();
