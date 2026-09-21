/**
 * @file 核心工具函数
 */
console.log('[core.js] 加载核心工具模块');

// ==================== 基础工具函数 ====================
const defaultRandomAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function __wx_uid__() {
  return random_string(12);
}

function random_string(length) {
  return random_string_with_alphabet(length, defaultRandomAlphabet);
}

function random_string_with_alphabet(length, alphabet) {
  let b = new Array(length);
  let max = alphabet.length;
  for (let i = 0; i < b.length; i++) {
    let n = Math.floor(Math.random() * max);
    b[i] = alphabet[n];
  }
  return b.join("");
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(() => { resolve(); }, ms || 1000);
  });
}

function __wx_channels_copy(text) {
  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.style.cssText = "position: absolute; top: -999px; left: -999px;";
  document.body.appendChild(textArea);
  textArea.select();
  document.execCommand("copy");
  document.body.removeChild(textArea);
}



function __wx_log(msg) {
  fetch("/__wx_channels_api/tip", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(msg),
  });
}

function __wx_load_script(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.type = "text/javascript";
    script.src = src;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function findElm(fn, timeout) {
  timeout = timeout || 5000;
  return new Promise((resolve) => {
    var startTime = Date.now();
    var check = function() {
      var elm = fn();
      if (elm) {
        resolve(elm);
      } else if (Date.now() - startTime < timeout) {
        setTimeout(check, 200);
      } else {
        resolve(null);
      }
    };
    check();
  });
}

// ==================== 全局状态 ====================
var __wx_channels_tip__ = {};
var __wx_channels_store__ = {
  profile: null,
};

console.log('[core.js] 核心工具模块加载完成');
