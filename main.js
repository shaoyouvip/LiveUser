/**
 * LiveUser browser client.
 *
 * Online count: Go WebSocket service from `serverUrl`.
 * Daily views: Cloudflare Worker + D1 endpoint at `/v1/visit`.
 */
(function() {
    'use strict';

    if (typeof window === 'undefined' || typeof document === 'undefined') {
        console.warn('[LiveUser] browser environment required');
        return;
    }

    const CONFIG = {{.JSON}};
    const SITE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,251}[a-z0-9])?$/;

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
        } catch {
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

    function viewsURL() {
        const url = serviceURL();
        if (!url) {
            return '';
        }
        url.protocol = url.protocol === 'wss:' || url.protocol === 'https:' ? 'https:' : 'http:';
        url.pathname = '/v1/visit';
        url.search = '';
        url.hash = '';
        return url.toString();
    }

    class LiveUser {
        constructor() {
            this.ws = null;
            this.isActive = !document.hidden;
            this.reconnectTimer = null;
            this.viewWriteController = null;
            this.viewReadController = null;
            this.viewRefreshTimer = null;
            this.currentCount = null;
            this.currentViews = null;
            this.displayElement = null;
            this.siteId = String(CONFIG.siteId || '').trim().toLowerCase() || currentSiteID();
            this.initialized = false;
        }

        init() {
            this.checkDisplayElement();
            this.setupEventListeners();

            if (!SITE_ID_PATTERN.test(this.siteId)) {
                this.log('siteId 格式不正确，已停止初始化');
                return;
            }

            this.initialized = true;
            this.log('LiveUser 初始化，站点: ' + this.siteId);
            this.recordView();
            this.connect();
            this.viewRefreshTimer = window.setInterval(() => this.refreshViews(), 5 * 60 * 1000);
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
                this.refreshViews();
                this.connect();
            });

            const close = () => {
                this.isActive = false;
                // 让浏览量请求完成，保证紧接着的刷新也能被计入。
                if (this.viewReadController) {
                    this.viewReadController.abort();
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
            this.refreshViews();
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
                socket.send(JSON.stringify({ type: 'join', siteId: this.siteId }));
            };

            socket.onmessage = event => {
                if (this.ws !== socket) {
                    return;
                }
                try {
                    this.handleMessage(JSON.parse(event.data));
                } catch {
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
            if (!data) {
                return;
            }
            if (data.type === 'update') {
                if (data.siteId !== this.siteId) {
                    return;
                }
                const count = Number(data.count);
                if (Number.isFinite(count) && count >= 0) {
                    this.currentCount = count;
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

        recordView() {
            if (!this.initialized || !this.isActive) {
                return;
            }
            const url = viewsURL();
            if (!url) {
                return;
            }
            if (this.viewWriteController) {
                this.viewWriteController.abort();
            }
            const controller = new AbortController();
            this.viewWriteController = controller;

            fetch(url, {
                method: 'POST',
                mode: 'cors',
                credentials: 'omit',
                cache: 'no-store',
                keepalive: true,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ siteId: this.siteId }),
                signal: controller.signal
            }).then(response => {
                if (!response.ok) {
                    throw new Error('HTTP ' + response.status);
                }
                return response.json();
            }).then(data => {
                if (this.viewWriteController !== controller) {
                    return;
                }
                this.updateViews(data);
            }).catch(error => {
                if (error.name !== 'AbortError') {
                    this.log('浏览量统计失败: ' + error.message);
                }
            }).finally(() => {
                if (this.viewWriteController === controller) {
                    this.viewWriteController = null;
                }
            });
        }

        refreshViews() {
            if (!this.initialized || !this.isActive || this.viewWriteController) {
                return;
            }
            const url = viewsURL();
            if (!url) {
                return;
            }
            const requestURL = new URL(url);
            requestURL.searchParams.set('siteId', this.siteId);
            if (this.viewReadController) {
                this.viewReadController.abort();
            }
            const controller = new AbortController();
            this.viewReadController = controller;

            fetch(requestURL.toString(), {
                method: 'GET',
                mode: 'cors',
                credentials: 'omit',
                cache: 'no-store',
                signal: controller.signal
            }).then(response => {
                if (!response.ok) {
                    throw new Error('HTTP ' + response.status);
                }
                return response.json();
            }).then(data => {
                if (this.viewReadController !== controller) {
                    return;
                }
                this.updateViews(data);
            }).catch(error => {
                if (error.name !== 'AbortError') {
                    this.log('浏览量统计失败: ' + error.message);
                }
            }).finally(() => {
                if (this.viewReadController === controller) {
                    this.viewReadController = null;
                }
            });
        }

        updateViews(data) {
            if (!data || data.siteId !== this.siteId) {
                return;
            }
            const views = Number(data.pv);
            if (Number.isFinite(views) && views >= 0) {
                this.currentViews = views;
                this.render();
                this.emitUpdate('views');
            }
        }

        render() {
            if (!this.displayElement) {
                this.checkDisplayElement();
            }
            if (!this.displayElement) {
                return;
            }
            const parts = [];
            if (this.currentCount !== null) {
                parts.push('在线 ' + this.currentCount);
            }
            if (this.currentViews !== null) {
                parts.push('浏览量 ' + this.currentViews);
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
                    count: this.currentCount,
                    views: this.currentViews,
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
            return this.currentCount === null ? 0 : this.currentCount;
        }

        getViews() {
            return this.currentViews === null ? 0 : this.currentViews;
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
            if (this.viewRefreshTimer) {
                window.clearInterval(this.viewRefreshTimer);
                this.viewRefreshTimer = null;
            }
            if (this.viewWriteController) {
                this.viewWriteController.abort();
                this.viewWriteController = null;
            }
            if (this.viewReadController) {
                this.viewReadController.abort();
                this.viewReadController = null;
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
        window.getLiveUserViews = function() {
            return window.LiveUser ? window.LiveUser.getViews() : 0;
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
