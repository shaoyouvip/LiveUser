package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestParseJSConfigDoesNotUseReferer(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "http://stats.example/liveuser.js?siteId=example-site", nil)
	request.Header.Set("Referer", "https://untrusted.example/private")
	config := parseJSConfig(request)

	if config.SiteID != "example-site" {
		t.Fatalf("siteId = %q, want example-site", config.SiteID)
	}
	if strings.Contains(config.SiteID, "untrusted") {
		t.Fatal("siteId must not be derived from Referer")
	}
	if config.ReconnectDelay != defaultReconnectDelayMilli {
		t.Fatalf("reconnectDelay = %d, want %d", config.ReconnectDelay, defaultReconnectDelayMilli)
	}

	request = httptest.NewRequest(http.MethodGet, "http://stats.example/liveuser.js", nil)
	request.Header.Set("Referer", "https://untrusted.example/private")
	config = parseJSConfig(request)
	if config.SiteID != "" {
		t.Fatalf("siteId = %q, want empty config when omitted", config.SiteID)
	}
}

func TestUpdateMessageUsesSingleCountField(t *testing.T) {
	encoded, err := json.Marshal(Message{Type: "update", SiteID: "example-site", Count: 2})
	if err != nil {
		t.Fatalf("marshal message: %v", err)
	}
	payload := string(encoded)
	if strings.Contains(payload, "\"online\"") {
		t.Fatalf("update payload must not include the removed online alias: %s", payload)
	}
	if !strings.Contains(payload, "\"count\":2") {
		t.Fatalf("update payload must contain count: %s", payload)
	}
}

func TestWebSocketBroadcastsCountAndDisconnect(t *testing.T) {
	server := newTestWebSocketServer(t)
	defer server.Close()

	first := dialWebSocket(t, server.URL, "http://example.com")
	defer first.Close()
	sendJoin(t, first, "example-site")
	assertUpdate(t, first, 1)

	second := dialWebSocket(t, server.URL, "http://example.com")
	defer second.Close()
	sendJoin(t, second, "example-site")

	assertUpdate(t, first, 2)
	assertUpdate(t, second, 2)

	if err := first.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, "")); err != nil {
		t.Fatalf("send close message: %v", err)
	}
	_ = first.Close()

	assertUpdate(t, second, 1)
}

func TestWebSocketRemovesEmptySiteAfterDisconnect(t *testing.T) {
	app := NewApp()
	server := httptest.NewServer(http.HandlerFunc(app.handleRequest))
	defer server.Close()

	conn := dialWebSocket(t, server.URL, "http://example.com")
	sendJoin(t, conn, "example-site")
	assertUpdate(t, conn, 1)
	_ = conn.Close()

	deadline := time.Now().Add(2 * time.Second)
	for {
		app.hub.mutex.RLock()
		_, exists := app.hub.sites["example-site"]
		app.hub.mutex.RUnlock()
		if !exists {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("empty site was not removed after the last client disconnected")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestBroadcastUsesLatestSiteCount(t *testing.T) {
	site := &Site{id: "example-site", clients: make(map[*Client]struct{})}
	first := &Client{send: make(chan Message, 1), done: make(chan struct{})}
	second := &Client{send: make(chan Message, 1), done: make(chan struct{})}
	site.clients[first] = struct{}{}

	site.broadcastMutex.Lock()
	done := make(chan struct{})
	go func() {
		site.broadcast()
		close(done)
	}()

	site.mutex.Lock()
	site.clients[second] = struct{}{}
	site.mutex.Unlock()
	site.broadcastMutex.Unlock()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("broadcast did not complete")
	}

	for _, client := range []*Client{first, second} {
		select {
		case message := <-client.send:
			if message.Count != 2 {
				t.Fatalf("count = %d, want 2", message.Count)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("client did not receive broadcast")
		}
	}
}

func TestWebSocketAllowsAnyOrigin(t *testing.T) {
	server := newTestWebSocketServer(t)
	defer server.Close()

	conn := dialWebSocket(t, server.URL, "https://untrusted.example")
	defer conn.Close()
	sendJoin(t, conn, "example-site")
	assertUpdate(t, conn, 1)
}

func TestWebSocketDerivesSiteIDFromOriginWhenOmitted(t *testing.T) {
	server := newTestWebSocketServer(t)
	defer server.Close()

	conn := dialWebSocket(t, server.URL, "http://example.com")
	defer conn.Close()
	sendJoin(t, conn, "")

	message := readMessage(t, conn)
	if message.Type != "update" || message.SiteID != "example.com" || message.Count != 1 {
		t.Fatalf("message = %#v, want update for example.com with count 1", message)
	}
}

func TestWebSocketRejectsDuplicateJoin(t *testing.T) {
	server := newTestWebSocketServer(t)
	defer server.Close()

	conn := dialWebSocket(t, server.URL, "http://example.com")
	defer conn.Close()
	sendJoin(t, conn, "example-site")
	assertUpdate(t, conn, 1)

	sendJoin(t, conn, "example-site")
	message := readMessage(t, conn)
	if message.Type != "error" || message.Message != "join already completed" {
		t.Fatalf("message = %#v, want duplicate join rejection", message)
	}
}

func newTestWebSocketServer(t *testing.T) *httptest.Server {
	t.Helper()
	app := NewApp()
	server := httptest.NewServer(http.HandlerFunc(app.handleRequest))
	return server
}

func dialWebSocket(t *testing.T, serverURL, origin string) *websocket.Conn {
	t.Helper()
	dialer := websocket.Dialer{HandshakeTimeout: 2 * time.Second}
	conn, response, err := dialer.Dial(webSocketURL(t, serverURL), http.Header{
		"Origin": []string{origin},
	})
	if err != nil {
		if response != nil {
			_ = response.Body.Close()
		}
		t.Fatalf("dial WebSocket: %v", err)
	}
	return conn
}

func webSocketURL(t *testing.T, serverURL string) string {
	t.Helper()
	parsed, err := url.Parse(serverURL)
	if err != nil {
		t.Fatalf("parse server URL: %v", err)
	}
	parsed.Scheme = "ws"
	return parsed.String()
}

func sendJoin(t *testing.T, conn *websocket.Conn, siteID string) {
	t.Helper()
	payload, err := json.Marshal(incomingMessage{Type: "join", SiteID: siteID})
	if err != nil {
		t.Fatalf("marshal join message: %v", err)
	}
	if err := conn.WriteMessage(websocket.TextMessage, payload); err != nil {
		t.Fatalf("send join message: %v", err)
	}
}

func assertUpdate(t *testing.T, conn *websocket.Conn, wantCount int) {
	t.Helper()
	message := readMessage(t, conn)
	if message.Type != "update" {
		t.Fatalf("message type = %q, want update", message.Type)
	}
	if message.Count != wantCount {
		t.Fatalf("count = %d, want %d", message.Count, wantCount)
	}
}

func readMessage(t *testing.T, conn *websocket.Conn) Message {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatalf("set read deadline: %v", err)
	}
	var message Message
	if err := conn.ReadJSON(&message); err != nil {
		t.Fatalf("read WebSocket message: %v", err)
	}
	return message
}
