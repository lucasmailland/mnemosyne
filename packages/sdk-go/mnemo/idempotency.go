package mnemo

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
)

// RequestOption customizes a single request. Options are applied in order;
// later options override earlier ones for the same field.
//
// The only option today is WithIdempotencyKey, but the variadic-option
// pattern keeps the public method signatures stable as the SDK grows
// (e.g. per-request timeouts or headers can be added without breaking
// callers).
type RequestOption func(*requestOptions)

// requestOptions is the resolved, internal view of all RequestOptions
// applied to one call.
type requestOptions struct {
	// idempotencyKey, when non-empty, is sent as the "Idempotency-Key"
	// HTTP header on the request. It is held constant across retries so
	// the server-side idempotency store deduplicates a retried mutation.
	idempotencyKey string
}

// applyRequestOptions folds a slice of RequestOption into a resolved
// requestOptions value. The zero value (no options) yields an empty
// idempotencyKey, i.e. idempotency is opt-in.
func applyRequestOptions(opts ...RequestOption) requestOptions {
	var resolved requestOptions
	for _, opt := range opts {
		if opt != nil {
			opt(&resolved)
		}
	}
	return resolved
}

// WithIdempotencyKey sets an explicit Idempotency-Key for a mutating
// request. Supply the SAME key when you retry a request you believe may
// have already been applied server-side; the server returns the original
// response instead of performing the mutation twice.
//
// To let the SDK pick a key for you, use NewIdempotencyKey:
//
//	key, _ := mnemo.NewIdempotencyKey()
//	_, err := client.CreateFact(ctx, input, mnemo.WithIdempotencyKey(key))
func WithIdempotencyKey(key string) RequestOption {
	return func(o *requestOptions) {
		o.idempotencyKey = key
	}
}

// NewIdempotencyKey returns a fresh RFC-4122 version-4 UUID suitable for
// use as an Idempotency-Key. It uses only crypto/rand from the standard
// library, preserving the SDK's zero-dependency guarantee.
//
// Generate ONE key BEFORE the first attempt and reuse it across retries
// of the same logical operation — generating a new key per attempt
// defeats the purpose.
func NewIdempotencyKey() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("mnemo: generate idempotency key: %w", err)
	}
	// Set version (4) and variant (RFC 4122) bits.
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10xx

	hexBuf := make([]byte, 32)
	hex.Encode(hexBuf, b[:])
	return fmt.Sprintf(
		"%s-%s-%s-%s-%s",
		hexBuf[0:8], hexBuf[8:12], hexBuf[12:16], hexBuf[16:20], hexBuf[20:32],
	), nil
}
