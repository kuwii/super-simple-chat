/*
 * crypto.js — Crypto 模块：会话加密的 Web Crypto 封装（AES-256-GCM + PBKDF2-SHA256），零依赖。
 *
 * 密钥派生：PBKDF2-SHA256(密码, 每会话随机盐, 固定迭代次数) → AES-256 原始密钥。
 * 记录加密：每条记录 JSON 序列化后 AES-GCM 加密（随机 12 字节 IV，tag 128 位），密文 base64 存储。
 * 密码校验：用会话密钥加密一段固定哨兵明文存入会话记录；解锁时重新解密比对
 *（GCM 认证失败或比对不符 = 密码错误，无需单独存储密码哈希）。
 * 本模块只做纯加密运算与编解码，不接触 IndexedDB / DOM / 界面文案。
 */
(function () {
  'use strict';

  window.SSC = window.SSC || {};

  var ITERATIONS = 210000;   /* PBKDF2 迭代次数（OWASP 2024 对 PBKDF2-SHA256 的基准建议） */
  var SALT_LEN = 16;         /* 随机盐长度（字节） */
  var IV_LEN = 12;           /* AES-GCM 标准 IV 长度（字节） */
  var SENTINEL = 'ssc-locked-v1'; /* 密码校验用的固定哨兵明文 */

  var Crypto = {};

  /**
   * 取 SubtleCrypto 实例（缺失时返回 null）。
   * 注意：crypto.subtle 仅在安全上下文（https / localhost）可用，纯 http 远程页面上为 undefined。
   * @returns {SubtleCrypto|null}
   */
  function subtle() {
    return window.crypto && window.crypto.subtle ? window.crypto.subtle : null;
  }

  /**
   * 当前浏览器是否支持本模块所需的全部加密能力（安全上下文下的 PBKDF2 + AES-GCM）。
   * @returns {boolean} true = 可用（加密功能应启用）；false = 不可用（界面应提示不可用）
   */
  Crypto.supported = function () {
    var s = subtle();
    return !!(s && s.deriveKey && s.encrypt && s.decrypt);
  };

  /**
   * 字节数组转 base64 字符串。
   * @param {Uint8Array} bytes 字节数组
   * @returns {string} base64 字符串
   */
  Crypto.bytesToB64 = function (bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  };

  /**
   * base64 字符串转字节数组。
   * @param {string} s base64 字符串
   * @returns {Uint8Array} 解码后的字节数组
   */
  Crypto.b64ToBytes = function (s) {
    var bin = atob(s);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  };

  /**
   * 生成随机盐（16 字节，crypto.getRandomValues）。
   * @returns {Promise<string>} 盐的 base64 表示
   */
  Crypto.randomSalt = function () {
    return new Promise(function (resolve, reject) {
      try {
        var b = new Uint8Array(SALT_LEN);
        window.crypto.getRandomValues(b);
        resolve(Crypto.bytesToB64(b));
      } catch (e) { reject(e); }
    });
  };

  /**
   * 由密码与盐派生 AES-256-GCM 原始密钥（PBKDF2-SHA256，固定迭代次数；同一密码+盐恒定得到同一密钥）。
   * @param {string} password 用户密码
   * @param {string} saltB64 盐（randomSalt 的产物）
   * @returns {Promise<CryptoKey>} AES-GCM 256 密钥（可 encrypt / decrypt）
   * @throws 浏览器不支持 Web Crypto 或派生失败时 reject
   */
  Crypto.deriveKey = async function (password, saltB64) {
    var s = subtle();
    if (!s) throw new Error('Web Crypto not available');
    var base = await s.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    return s.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: Crypto.b64ToBytes(saltB64), iterations: ITERATIONS },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  };

  /**
   * 加密任意可 JSON 化值：JSON 序列化 → AES-GCM（随机 IV）。
   * @param {CryptoKey} key AES-GCM 密钥
   * @param {*} obj 要加密的值（经 JSON 序列化）
   * @returns {Promise<{iv: string, ct: string}>} iv / ct 均为 base64 字符串
   */
  Crypto.seal = async function (key, obj) {
    var s = subtle();
    var iv = new Uint8Array(IV_LEN);
    window.crypto.getRandomValues(iv);
    var ct = await s.encrypt(
      { name: 'AES-GCM', iv: iv, tagLength: 128 },
      key,
      new TextEncoder().encode(JSON.stringify(obj))
    );
    return { iv: Crypto.bytesToB64(iv), ct: Crypto.bytesToB64(new Uint8Array(ct)) };
  };

  /**
   * 解密 seal 的产物（GCM 认证：密钥不符 / 数据被篡改时解密失败）。
   * @param {CryptoKey} key AES-GCM 密钥
   * @param {{iv: string, ct: string}} env 加密封套（seal 的产物）
   * @returns {Promise<*>} 解密并 JSON 还原后的原值
   * @throws 认证失败（错误密钥）、数据损坏或 JSON 非法时 reject
   */
  Crypto.open = async function (key, env) {
    var s = subtle();
    var plain = await s.decrypt(
      { name: 'AES-GCM', iv: Crypto.b64ToBytes(env.iv), tagLength: 128 },
      key,
      Crypto.b64ToBytes(env.ct)
    );
    return JSON.parse(new TextDecoder().decode(plain));
  };

  /**
   * 生成哨兵密文（密码校验凭据）：加密固定哨兵明文。
   * 格式：base64(iv) + ':' + base64(ct)。
   * @param {CryptoKey} key AES-GCM 密钥
   * @returns {Promise<string>} 哨兵密文字符串
   */
  Crypto.makeSentinel = async function (key) {
    var r = await Crypto.seal(key, SENTINEL);
    return r.iv + ':' + r.ct;
  };

  /**
   * 校验哨兵密文（等价于校验密码）：用密钥解密并与固定哨兵明文比对。
   * 解密失败（GCM 认证不通过）或比对不符一律返回 false，不抛错。
   * @param {CryptoKey} key 由待验证密码派生的 AES-GCM 密钥
   * @param {string} sentinel makeSentinel 的产物（'iv:ct' 格式）
   * @returns {Promise<boolean>} true = 密码正确
   */
  Crypto.verifySentinel = async function (key, sentinel) {
    var p = String(sentinel || '').indexOf(':');
    if (p < 0) return false;
    try {
      return await Crypto.open(key, { iv: sentinel.slice(0, p), ct: sentinel.slice(p + 1) }) === SENTINEL;
    } catch (e) {
      return false;
    }
  };

  SSC.Crypto = Crypto;
})();
