// views/escapeHtml.js — leaf module, same helper as car_show_admin_console /
// mmoa_web_app.

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// A JS string literal that is safe INSIDE a double-quoted HTML attribute
// (an Alpine x-on / x-data expression): single-quoted, with quotes,
// backslashes, angle brackets and ampersands escaped as JS escapes. Neither
// escapeHtml (the browser decodes &#39; back to ' BEFORE Alpine parses the
// expression, breaking the string on names like O'Brien) nor JSON.stringify
// (its double quotes end the attribute) is safe there.
function jsAttrStr(s) {
  return "'" + String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\x22')
    .replace(/</g, '\\x3c')
    .replace(/>/g, '\\x3e')
    .replace(/&/g, '\\x26')
    .replace(/\r?\n/g, '\\n') + "'";
}

module.exports = { escapeHtml, jsAttrStr };
