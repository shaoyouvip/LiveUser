package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"flag"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"text/template"
	"time"

	"github.com/gorilla/websocket"
)

const (
	maxMessageBytes            = 1024
	writeWait                  = 10 * time.Second
	pongWait                   = 60 * time.Second
	pingPeriod                 = (pongWait * 9) / 10
	defaultReconnectDelayMilli = 5000
	minReconnectDelayMilli     = 1000
	maxReconnectDelayMilli     = 60000
)

var siteIDPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9._-]{0,251}[a-z0-9])?$`)

// Version is set by the build pipeline.
var Version = "dev"

//go:embed demo.html
var demoHTML string

//go:embed main.js
var mainJS string

var scriptTemplate = template.Must(template.New("liveuser").Parse(mainJS))

type incomingMessage struct {
	Type   string `json:"type"`
	SiteID string `json:"siteId,omitempty"`
}

// Message is the server-to-client WebSocket message.
type Message struct {
	Type      string `json:"type"`
	SiteID    string `json:"siteId,omitempty"`
	Count     int    `json:"count,omitempty"`
	Message   string `json:"message,omitempty"`
	Timestamp int64  `json:"timestamp,omitempty"`
}

type JSConfig struct {
	ServerURL        string `json:"serverUrl"`
	SiteID           string `json:"siteId"`
	DisplayElementID string `json:"displayElementId"`
	ReconnectDelay   int    `json:"reconnectDelay"`
	Debug            bool   `json:"debug"`
}

func (c JSConfig) JSON() string {
	encoded, err := json.Marshal(c)
	if err != nil {
		return `{}`
	}
	return string(encoded)
}

type Site struct {
	id             string
	clients        map[*Client]struct{}
	mutex          sync.RWMutex
	broadcastMutex sync.Mutex
}

type Hub struct {
	sites map[string]*Site
	mutex sync.RWMutex
}

func NewHub() *Hub {
	return &Hub{sites: make(map[string]*Site)}
}

func (h *Hub) register(client *Client) {
	if client.site != nil || client.joined {
		return
	}

	h.mutex.Lock()
	site := h.sites[client.siteID]
	if site == nil {
		site = &Site{id: client.siteID, clients: make(map[*Client]struct{})}
		h.sites[client.siteID] = site
	}

	site.mutex.Lock()
	site.clients[client] = struct{}{}
	client.site = site
	client.joined = true
	site.mutex.Unlock()
	h.mutex.Unlock()

	site.broadcast()
}

func (h *Hub) unregister(client *Client) {
	h.mutex.Lock()
	site := client.site
	if site == nil {
		h.mutex.Unlock()
		return
	}

	site.mutex.Lock()
	if _, exists := site.clients[client]; !exists {
		site.mutex.Unlock()
		h.mutex.Unlock()
		return
	}
	delete(site.clients, client)
	client.site = nil
	client.joined = false
	count := len(site.clients)
	if count == 0 && h.sites[site.id] == site {
		delete(h.sites, site.id)
	}
	site.mutex.Unlock()
	h.mutex.Unlock()

	site.broadcast()
}

func (site *Site) broadcast() {
	site.broadcastMutex.Lock()
	defer site.broadcastMutex.Unlock()

	site.mutex.RLock()
	count := len(site.clients)
	clients := make([]*Client, 0, count)
	for client := range site.clients {
		clients = append(clients, client)
	}
	site.mutex.RUnlock()

	message := Message{
		Type:      "update",
		SiteID:    site.id,
		Count:     count,
		Timestamp: time.Now().Unix(),
	}
	for _, client := range clients {
		select {
		case client.send <- message:
		default:
			// A slow client must not block broadcasts. Closing its socket makes
			// the read pump perform the normal unregister cleanup.
			client.close()
		}
	}
}

func (h *Hub) sendShutdown(message Message) {
	h.mutex.RLock()
	sites := make([]*Site, 0, len(h.sites))
	for _, site := range h.sites {
		sites = append(sites, site)
	}
	h.mutex.RUnlock()

	for _, site := range sites {
		site.mutex.RLock()
		clients := make([]*Client, 0, len(site.clients))
		for client := range site.clients {
			clients = append(clients, client)
		}
		site.mutex.RUnlock()

		for _, client := range clients {
			select {
			case client.send <- message:
			default:
			}
			client.close()
		}
	}
}

type Client struct {
	conn          *websocket.Conn
	hub           *Hub
	send          chan Message
	done          chan struct{}
	closeOnce     sync.Once
	defaultSiteID string
	siteID        string
	site          *Site
	joined        bool
}

func newClient(conn *websocket.Conn, hub *Hub, defaultSiteID string) *Client {
	return &Client{
		conn:          conn,
		hub:           hub,
		send:          make(chan Message, 32),
		done:          make(chan struct{}),
		defaultSiteID: defaultSiteID,
	}
}

func (c *Client) close() {
	c.closeOnce.Do(func() {
		close(c.done)
		_ = c.conn.Close()
	})
}

func (c *Client) sendMessage(message Message) {
	select {
	case c.send <- message:
	case <-c.done:
	default:
	}
}

func (c *Client) readPump() {
	defer func() {
		c.hub.unregister(c)
		c.close()
	}()

	c.conn.SetReadLimit(maxMessageBytes)
	_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(pongWait))
	})

	for {
		_, payload, err := c.conn.ReadMessage()
		if err != nil {
			return
		}

		var message incomingMessage
		if err := json.Unmarshal(payload, &message); err != nil {
			c.sendError("invalid JSON")
			continue
		}
		if message.Type != "join" {
			c.sendError("unsupported message type")
			continue
		}
		if c.joined {
			c.sendError("join already completed")
			continue
		}
		siteID := strings.ToLower(strings.TrimSpace(message.SiteID))
		if siteID == "" {
			siteID = c.defaultSiteID
		}
		if !siteIDPattern.MatchString(siteID) {
			c.sendError("invalid siteId")
			continue
		}
		c.siteID = siteID
		c.hub.register(c)
	}
}

func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer ticker.Stop()
	defer c.close()

	for {
		select {
		case message := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteJSON(message); err != nil {
				return
			}
		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		case <-c.done:
			return
		}
	}
}

func (c *Client) sendError(message string) {
	c.sendMessage(Message{Type: "error", Message: message, Timestamp: time.Now().Unix()})
}

type App struct {
	hub      *Hub
	upgrader websocket.Upgrader
}

func NewApp() *App {
	return &App{
		hub: NewHub(),
		upgrader: websocket.Upgrader{
			ReadBufferSize:  1024,
			WriteBufferSize: 1024,
			CheckOrigin: func(r *http.Request) bool {
				return true
			},
		},
	}
}

func (a *App) handleRequest(w http.ResponseWriter, r *http.Request) {
	if isWebSocketRequest(r) {
		a.handleWebSocket(w, r)
		return
	}

	if r.Method == http.MethodGet && r.URL.Path == "/liveuser.js" {
		a.handleJavaScript(w, r)
		return
	}
	if r.Method == http.MethodGet && r.URL.Path == "/" {
		a.handleDemoPage(w)
		return
	}

	http.NotFound(w, r)
}

func (a *App) handleJavaScript(w http.ResponseWriter, r *http.Request) {
	config := parseJSConfig(r)
	w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if err := scriptTemplate.Execute(w, config); err != nil {
		log.Printf("failed to render liveuser.js: %v", err)
	}
}

func parseJSConfig(r *http.Request) JSConfig {
	params := r.URL.Query()
	requestScheme := "http"
	if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		requestScheme = "https"
	}
	wsScheme := "ws"
	if requestScheme == "https" {
		wsScheme = "wss"
	}
	defaultServerURL := wsScheme + "://" + r.Host + "/"

	return JSConfig{
		ServerURL:        getParam(params, "serverUrl", defaultServerURL),
		SiteID:           getParam(params, "siteId", ""),
		DisplayElementID: getParam(params, "displayElementId", "liveuser"),
		ReconnectDelay:   getClampedIntParam(params, "reconnectDelay", defaultReconnectDelayMilli, minReconnectDelayMilli, maxReconnectDelayMilli),
		Debug:            getBoolParam(params, "debug", false),
	}
}

func (a *App) handleDemoPage(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write([]byte(demoHTML))
}

func (a *App) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := a.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}

	client := newClient(conn, a.hub, siteIDFromOrigin(r.Header.Get("Origin")))
	go client.writePump()
	client.readPump()
}

func siteIDFromOrigin(origin string) string {
	parsed, err := url.Parse(strings.TrimSpace(origin))
	if err != nil {
		return ""
	}
	return strings.ToLower(parsed.Hostname())
}

func isWebSocketRequest(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
}

func getParam(params url.Values, key, defaultValue string) string {
	if value := strings.TrimSpace(params.Get(key)); value != "" {
		return value
	}
	return defaultValue
}

func getClampedIntParam(params url.Values, key string, defaultValue, minimum, maximum int) int {
	value := strings.TrimSpace(params.Get(key))
	if value == "" {
		return defaultValue
	}
	intValue, err := strconv.Atoi(value)
	if err != nil {
		return defaultValue
	}
	if intValue < minimum {
		return minimum
	}
	if intValue > maximum {
		return maximum
	}
	return intValue
}

func getBoolParam(params url.Values, key string, defaultValue bool) bool {
	value := strings.TrimSpace(params.Get(key))
	if value == "" {
		return defaultValue
	}
	boolValue, err := strconv.ParseBool(value)
	if err != nil {
		return defaultValue
	}
	return boolValue
}

func main() {
	addr := flag.String("addr", "0.0.0.0:10086", "监听地址")
	flag.Parse()

	app := NewApp()
	server := &http.Server{
		Addr:              *addr,
		Handler:           http.HandlerFunc(app.handleRequest),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	go func() {
		log.Printf("LiveUser v%s 启动成功，监听 %s", Version, *addr)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("服务器启动失败: %v", err)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	log.Println("正在关闭服务器...")

	app.hub.sendShutdown(Message{
		Type:    "shutdown",
		Message: "服务器重启中，请稍后重连",
	})

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		log.Printf("HTTP 服务关闭失败: %v", err)
	}
	log.Println("服务器已关闭")
}
