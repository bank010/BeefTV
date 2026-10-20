package operations

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
)

type reviewDomain struct {
	*mediaDomain
	calls int
	part  MediaPart
}

func (d *reviewDomain) ReviewMedia(_ context.Context, p MediaPart, q string) (MediaReviewObservation, error) {
	d.calls++
	d.part = p
	return MediaReviewObservation{Model: "fixture", RequestID: "request", Text: q}, nil
}

func TestMediaReviewUsesOwnedVersionedClipAndDoesNotExposeBytes(t *testing.T) {
	data := nativeMediaFixture(t, true, false)
	sum := sha256.Sum256(data)
	d := &reviewDomain{mediaDomain: &mediaDomain{owner: "owner", data: data}}
	ctx := &Context{Context: context.Background(), UserID: "owner", Domain: d}
	args := mediaReviewArgs{CanvasID: "canvas", NodeID: "node", ExpectedVersion: hex.EncodeToString(sum[:]), StartMs: 200, EndMs: 1200, Question: "观察动作和声音"}
	call := func(a mediaReviewArgs) (any, error) { b, _ := json.Marshal(a); return runMediaReview(ctx, b) }
	result, err := call(args)
	if err != nil {
		t.Fatal(err)
	}
	if d.calls != 1 || d.part.Source.StartMs != 200 || d.part.Source.EndMs != 1200 || d.part.MimeType != "video/mp4" {
		t.Fatalf("wrong bounded source: %+v", d.part.Source)
	}
	bytes, err := base64.StdEncoding.DecodeString(d.part.Data)
	if err != nil || len(bytes) == 0 {
		t.Fatal("missing actual media")
	}
	hash := sha256.Sum256(bytes)
	if hex.EncodeToString(hash[:]) != d.part.SHA256 {
		t.Fatal("wrong wire hash")
	}
	raw, _ := json.Marshal(result)
	if strings.Contains(string(raw), d.part.Data) {
		t.Fatal("native bytes leaked into model observation")
	}
	for _, change := range []func(*mediaReviewArgs){func(a *mediaReviewArgs) { a.CanvasID = "foreign" }, func(a *mediaReviewArgs) { a.ExpectedVersion = "stale" }, func(a *mediaReviewArgs) { a.EndMs = 20000 }, func(a *mediaReviewArgs) { a.Question = "" }} {
		bad := args
		change(&bad)
		if _, err := call(bad); err == nil {
			t.Fatal("invalid review accepted")
		}
		if d.calls != 1 {
			t.Fatal("invalid reference incurred inference")
		}
	}
	r := NewRegistry(nil, nil)
	registerMediaOps(r)
	desc, _ := r.Descriptor("media.review")
	if !desc.ReadOnly || desc.Replay != "unsafe" {
		t.Fatal("paid read must not replay automatically")
	}
}
