package handler

import (
	"net/http/httptest"
	"testing"
)

func TestLocalDepthComponentRequest(t *testing.T) {
	tests := []struct {
		name   string
		host   string
		remote string
		origin string
		want   bool
	}{
		{name: "vite proxy", host: "127.0.0.1:18082", remote: "127.0.0.1:54321", origin: "http://127.0.0.1:13000", want: true},
		{name: "local without origin", host: "localhost:18082", remote: "[::1]:54321", want: true},
		{name: "remote caller", host: "127.0.0.1:18082", remote: "192.168.1.2:54321", origin: "http://127.0.0.1:13000"},
		{name: "remote host", host: "192.168.1.2:18082", remote: "127.0.0.1:54321", origin: "http://127.0.0.1:13000"},
		{name: "remote origin", host: "127.0.0.1:18082", remote: "127.0.0.1:54321", origin: "https://example.com"},
		{name: "spoofed origin", host: "127.0.0.1:18082", remote: "127.0.0.1:54321", origin: "http://localhost.attacker.example"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest("GET", "http://"+test.host+"/api/depth-components/status", nil)
			request.RemoteAddr = test.remote
			if test.origin != "" {
				request.Header.Set("Origin", test.origin)
			}
			if got := localDepthComponentRequest(request); got != test.want {
				t.Fatalf("localDepthComponentRequest() = %v, want %v", got, test.want)
			}
		})
	}
}
