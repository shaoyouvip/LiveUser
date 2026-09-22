/**
 * LiveUser browser client.
 *
 * Online count: Go WebSocket service from `serverUrl`.
 * Daily visitors: Cloudflare Worker + D1 endpoint at `/v1/visit`.
 */
(function() {
    'use strict';

    if (typeof window === 'undefined' || typeof document === 'undefined') {
        console.warn('[LiveUser] browser environment required');
        return;
    }

    const CONFIG = {{.JSON}};
    const VISITOR_STORAGE_PREFIX = 'liveuser:visitorId:';
    const SITE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,251}[a-z0-9])?$/;
    const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    function currentSiteID() {
        const hostname = String(window.location.hostname || '').trim().toLowerCase();
        return hostname || 'default-site';
    }

    function serviceURL() {
        const configured = String(CONFIG.serverUrl || '').trim();
        if (!configured) {
            return null;
        }
        try {
            const url = new URL(configured, window.location.href);
            if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
                return null;
            }
            return url;
        } catch (error) {
            return null;
        }
    }

    function websocketURL() {
        const url = serviceURL();
        if (!url) {
            return '';
        }
        url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:';
        return url.toString();
    }

    function visitsURL() {
        const url = serviceURL();
        if (!url) {
            return '';
        }
        try {
            url.protocol = url.protocol === 'wss:' || url.protocol === 'https:' ? 'https:' : 'http:';
            url.pathname = '/v1/visit';
            url.search = '';
            url.hash = '';
            return url.toString();
        } catch (error) {
            return '';
        }
    }

    function createVisitorID() {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
        if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
            const bytes = new Uint8Array(16);
            crypto.getRandomValues(bytes);
            bytes[6] = (bytes[6] & 0x0f) | 0x40;
            bytes[8] = (bytes[8] & 0x3f) | 0x80;
            const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
            return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        }
        throw new Error('Web Crypto API is required');
    }

    function loadVisitorID(siteId) {
        const key = VISITOR_STORAGE_PREFIX + siteId;
        try {
            const stored = window.localStorage.getItem(key);
            if (stored && UUID_PATTERN.test(stored)) {
                return stored;
            }
            const created = createVisitorID();
            window.localStorage.setItem(key, created);
            return created;
        } catch (error) {
            // Private browsing or strict storage policies may disable localStorage.
            return createVisitorID();
        }
    }

    class LiveUser {
        constructor() {
            this.ws = null;
            this.isActive = !document.hidden;
            this.reconnectTimer = null;
            this.visitRefreshTimer = null;
            this.visitController = null;
            this.currentOnline = null;
            this.currentToday = null;
            this.displayElement = null;
            this.siteId = String(CONFIG.siteId || '').trim().toLowerCase() || currentSiteID();
            this.visitorId = null;
            this.initialized = false;
        }

        init() {
            this.checkDisplayElement();
            this.setupEventListeners();

            if (!SITE_ID_PATTERN.test(this.siteId)) {
                this.log('siteId 格式不正确，已停止初始化');
                return;
            }

            this.visitorId = loadVisitorID(this.siteId);
            this.initialized = true;
            this.log('LiveUser 初始化，站点: ' + this.siteId);
            this.recordVisit();
            this.connect();
            this.visitRefreshTimer = window.setInterval(() => this.recordVisit(), 5 * 60 * 1000);
        }

        checkDisplayElement() {
            this.displayElement = document.getElementById(CONFIG.displayElementId);
            if (!this.displayElement) {
                this.log('未找到显示元素 #' + CONFIG.displayElementId);
            }
        }

        setupEventListeners() {
            document.addEventListener('visibilitychange', () => this.resume());
            window.addEventListener('pageshow', () => this.resume());

            window.addEventListener('online', () => {
                this.log('网络恢复');
                this.recordVisit();
                this.connect();
            });

            const close = () => {
                this.isActive = false;
                if (this.visitController) {
                    this.visitController.abort();
                }
                if (this.ws) {
                    this.ws.close(1000, 'page closed');
                }
            };
            window.addEventListener('beforeunload', close);
            window.addEventListener('pagehide', close);
        }

        resume() {
            this.isActive = !document.hidden;
            if (!this.isActive) {
                return;
            }
            this.recordVisit();
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                this.connect();
            }
        }

        connect() {
            if (!this.initialized || !this.isActive) {
                return;
            }
            if (this.reconnectTimer) {
                window.clearTimeout(this.reconnectTimer);
                this.reconnectTimer = null;
            }
            if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
                return;
            }

            const url = websocketURL();
            if (!url) {
                this.log('serverUrl 未配置');
                return;
            }

            this.log('连接 WebSocket: ' + url);
            let socket;
            try {
                socket = new WebSocket(url);
                this.ws = socket;
            } catch (error) {
                this.log('连接失败: ' + error.message);
                this.scheduleReconnect();
                return;
            }

            socket.onopen = () => {
                if (this.ws !== socket) {
                    return;
                }
                socket.send(JSON.stringify({
                    type: 'join',
                    siteId: this.siteId,
                    visitorId: this.visitorId
                }));
            };

            socket.onmessage = event => {
                if (this.ws !== socket) {
                    return;
                }
                try {
                    this.handleMessage(JSON.parse(event.data));
                } catch (error) {
                    this.log('消息解析失败');
                }
            };

            socket.onclose = () => {
                if (this.ws === socket) {
                    this.ws = null;
                }
                if (this.isActive) {
                    this.scheduleReconnect();
                }
            };

            socket.onerror = () => {
                this.log('WebSocket 连接错误');
            };
        }

        handleMessage(data) {
            if (!data || data.siteId !== this.siteId) {
                return;
            }
            if (data.type === 'update') {
                const online = Number(data.online);
                const fallback = Number(data.count);
                const value = Number.isFinite(online) ? online : fallback;
                if (Number.isFinite(value) && value >= 0) {
                    this.currentOnline = value;
                    this.render();
                    this.emitUpdate('websocket');
                }
                return;
            }
            if (data.type === 'shutdown') {
                this.log('服务器通知: ' + (data.message || '服务器维护'));
                return;
            }
            if (data.type === 'error') {
                this.log('服务器拒绝连接: ' + (data.message || 'unknown error'));
            }
        }

        recordVisit() {
            if (!this.initialized || !this.isActive) {
                return;
            }
            const url = visitsURL();
            if (!url) {
                return;
            }
            if (this.visitController) {
                this.visitController.abort();
            }
            const controller = new AbortController();
            this.visitController = controller;

            fetch(url, {
                method: 'POST',
                mode: 'cors',
                credentials: 'omit',
                cache: 'no-store',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ siteId: this.siteId, visitorId: this.visitorId }),
                signal: controller.signal
            }).then(response => {
                if (!response.ok) {
                    throw new Error('HTTP ' + response.status);
                }
                return response.json();
            }).then(data => {
                if (this.visitController !== controller || !data || data.siteId !== this.siteId) {
                    return;
                }
                const today = Number(data.today);
                if (Number.isFinite(today) && today >= 0) {
                    this.currentToday = today;
                    this.render();
                    this.emitUpdate('visit');
                }
            }).catch(error => {
                if (error.name !== 'AbortError') {
                    this.log('今日访问统计失败: ' + error.message);
                }
            }).finally(() => {
                if (this.visitController === controller) {
                    this.visitController = null;
                }
            });
        }

        render() {
            if (!this.displayElement) {
                this.checkDisplayElement();
            }
            if (!this.displayElement) {
                return;
            }
            const parts = [];
            if (this.currentOnline !== null) {
                parts.push('在线 ' + this.currentOnline);
            }
            if (this.currentToday !== null) {
                parts.push('今日 ' + this.currentToday);
            }
            if (parts.length > 0) {
                this.displayElement.textContent = parts.join(' · ');
                this.displayElement.classList.add('updating');
                window.setTimeout(() => this.displayElement && this.displayElement.classList.remove('updating'), 300);
            }
        }

        emitUpdate(reason) {
            const event = new CustomEvent('liveuser:update', {
                detail: {
                    siteId: this.siteId,
                    online: this.currentOnline,
                    today: this.currentToday,
                    count: this.currentOnline,
                    reason: reason
                }
            });
            window.dispatchEvent(event);
        }

        scheduleReconnect() {
            if (this.reconnectTimer || !this.isActive) {
                return;
            }
            const baseDelay = Math.max(1000, Number(CONFIG.reconnectDelay) || 5000);
            const delay = baseDelay + Math.floor(Math.random() * (baseDelay + 1));
            this.log('将在 ' + Math.ceil(delay / 1000) + ' 秒后重连');
            this.reconnectTimer = window.setTimeout(() => {
                this.reconnectTimer = null;
                if (this.isActive) {
                    this.connect();
                }
            }, delay);
        }

        getCount() {
            return this.currentOnline === null ? 0 : this.currentOnline;
        }

        getToday() {
            return this.currentToday === null ? 0 : this.currentToday;
        }

        getStatus() {
            if (!this.initialized) return 'invalid-config';
            if (!this.ws) return 'disconnected';
            const states = {
                [WebSocket.CONNECTING]: 'connecting',
                [WebSocket.OPEN]: 'connected',
                [WebSocket.CLOSING]: 'closing',
                [WebSocket.CLOSED]: 'closed'
            };
            return states[this.ws.readyState] || 'unknown';
        }

        disconnect() {
            this.isActive = false;
            if (this.reconnectTimer) {
                window.clearTimeout(this.reconnectTimer);
                this.reconnectTimer = null;
            }
            if (this.visitRefreshTimer) {
                window.clearInterval(this.visitRefreshTimer);
                this.visitRefreshTimer = null;
            }
            if (this.visitController) {
                this.visitController.abort();
                this.visitController = null;
            }
            if (this.ws) {
                this.ws.close(1000, 'manual disconnect');
                this.ws = null;
            }
        }

        reconnect() {
            this.isActive = true;
            this.connect();
        }

        log(message) {
            if (CONFIG.debug) {
                console.log('[LiveUser] ' + message);
            }
        }
    }

    function initLiveUser() {
        window.LiveUser = new LiveUser();
        window.LiveUser.init();

        window.getLiveUserCount = function() {
            return window.LiveUser ? window.LiveUser.getCount() : 0;
        };
        window.getLiveUserToday = function() {
            return window.LiveUser ? window.LiveUser.getToday() : 0;
        };
        window.getLiveUserStatus = function() {
            return window.LiveUser ? window.LiveUser.getStatus() : 'not-initialized';
        };
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initLiveUser, { once: true });
    } else {
        initLiveUser();
    }
})();
