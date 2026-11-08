/**
 * 丢进 GitHub Pages 的音乐页即可。
 *
 *   <script src="https://你的后端/ncm-client.js"></script>
 *   <script>
 *     NCM.base = "https://你的后端";
 *     await NCM.login();          // 弹出二维码，扫完自动拿到 session
 *     const { created, collected } = await NCM.playlists();
 *   </script>
 */
(function (global) {
  const KEY = "ncm_session";

  function store(token) {
    if (token) localStorage.setItem(KEY, token);
    else localStorage.removeItem(KEY);
  }

  const NCM = {
    base: "",
    get session() {
      return localStorage.getItem(KEY) || "";
    },
    set session(v) {
      store(v);
    },
    loggedIn() {
      return Boolean(this.session);
    },
    async request(path, opts = {}) {
      const headers = Object.assign({ Accept: "application/json" }, opts.headers || {});
      if (this.session) headers.Authorization = "Bearer " + this.session;
      if (opts.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
      const res = await fetch(this.base.replace(/\/$/, "") + path, {
        method: opts.method || "GET",
        headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(data.error || res.statusText);
        err.status = res.status;
        err.body = data;
        throw err;
      }
      return data;
    },
    async login(onQr) {
      const start = await this.request("/login/qr");
      if (typeof onQr === "function") onQr(start.qrCodeUrl, start);
      const deadline = Date.now() + 5 * 60 * 1000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        const poll = await this.request("/login/qr/poll?ticket=" + encodeURIComponent(start.ticket));
        if (poll.status === 803 && poll.session) {
          this.session = poll.session;
          return poll;
        }
        if (poll.status === 800) throw new Error("二维码过期，请重试");
      }
      throw new Error("登录超时");
    },
    logout() {
      const p = this.session ? this.request("/logout", { method: "POST" }).catch(() => {}) : Promise.resolve();
      this.session = "";
      return p;
    },
    me() {
      return this.request("/api/me");
    },
    playlists() {
      return this.request("/api/playlists");
    },
    tracks(id) {
      return this.request("/api/playlists/" + encodeURIComponent(id));
    },
    search(q) {
      return this.request("/api/search?q=" + encodeURIComponent(q));
    },
    song(id) {
      return this.request("/api/song/" + encodeURIComponent(id));
    },
    lyric(id) {
      return this.request("/api/lyric/" + encodeURIComponent(id));
    },
    like(id, like) {
      return this.request("/api/like", { method: "POST", body: { songId: id, like: Boolean(like) } });
    },
  };

  global.NCM = NCM;
})(typeof window !== "undefined" ? window : globalThis);
