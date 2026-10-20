package handler

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"infinite-canvas/backend/internal/app"

	"github.com/gin-gonic/gin"
)

func RegisterDepthComponentRoutes(api *gin.RouterGroup, svc *app.Service) {
	component := func(c *gin.Context, write bool) DepthComponentPort {
		if !trustedDesktopUI(c) && !localDepthComponentRequest(c.Request) {
			fail(c, http.StatusForbidden, app.Forbidden("深度捕捉组件只能从本机浏览器管理"))
			return nil
		}
		if write && !requireTrustedDesktopWritePrincipal(c, "深度捕捉组件只能由当前工作区管理") {
			return nil
		}
		if _, err := currentUser(c, svc); err != nil {
			failService(c, err)
			return nil
		}
		dependencies, ok := runtimeDependencies(c)
		if !ok || dependencies.DepthComponents == nil {
			fail(c, http.StatusServiceUnavailable, errors.New("深度捕捉组件不可用"))
			return nil
		}
		return dependencies.DepthComponents
	}

	api.GET("/depth-components/status", func(c *gin.Context) {
		port := component(c, false)
		if port == nil {
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 25*time.Second)
		defer cancel()
		state, err := port.ComponentStatus(ctx, c.Query("refresh") == "true")
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, state)
	})
	api.POST("/depth-components/download", func(c *gin.Context) {
		port := component(c, true)
		if port == nil {
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 25*time.Second)
		defer cancel()
		state, err := port.StartComponentDownload(ctx)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, state)
	})
	api.POST("/depth-components/pause", func(c *gin.Context) {
		port := component(c, true)
		if port == nil {
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Minute)
		defer cancel()
		if err := port.PauseComponentDownload(ctx); err != nil {
			failService(c, err)
			return
		}
		state, err := port.ComponentStatus(ctx)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, state)
	})
}

func localDepthComponentRequest(request *http.Request) bool {
	if request == nil || !isLoopbackHost(request.Host) {
		return false
	}
	remote, _, err := net.SplitHostPort(request.RemoteAddr)
	if err != nil {
		remote = request.RemoteAddr
	}
	if !isLoopbackHost(remote) {
		return false
	}
	origin := strings.TrimSpace(request.Header.Get("Origin"))
	if origin == "" {
		return true
	}
	parsed, err := url.Parse(origin)
	return err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") && isLoopbackHost(parsed.Host) && parsed.User == nil && parsed.Path == "" && parsed.RawQuery == "" && parsed.Fragment == ""
}
