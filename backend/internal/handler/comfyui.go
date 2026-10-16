package handler

import (
	"net/http"

	"infinite-canvas/backend/internal/app"

	"github.com/gin-gonic/gin"
)

// RegisterComfyUIRoutes exposes workflow management through the local backend,
// keeping the browser away from the configured ComfyUI instance.
func RegisterComfyUIRoutes(r *gin.RouterGroup, svc *app.Service) {
	fetch := func(c *gin.Context, isFile bool) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		if err := svc.RequireWorkflowPluginForUser(user.ID, "comfyui-workflow-image"); err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 16<<10)
		var req app.ComfyUIUserDataRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		if isFile {
			result, err := svc.FetchComfyUIWorkflow(c.Request.Context(), req)
			if err != nil {
				failService(c, err)
				return
			}
			ok(c, result)
			return
		}
		result, err := svc.FetchComfyUIUserData(c.Request.Context(), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, result)
	}
	r.POST("/comfyui/userdata", func(c *gin.Context) { fetch(c, false) })
	r.POST("/comfyui/workflow-info", func(c *gin.Context) { fetch(c, true) })
}
