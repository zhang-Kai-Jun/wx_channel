package utils

import (
	"crypto/rand"

	"fmt"

	"strconv"
)

// RandomString generates a random string of length n
func RandomString(n int) string {
	const letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	b := make([]byte, n)
	rand.Read(b)
	for i := range b {
		b[i] = letters[b[i]%byte(len(letters))]
	}
	return string(b)
}

// ParseKey parses a key string into uint64 seed
func ParseKey(key string) (uint64, error) {
	if seed, err := strconv.ParseUint(key, 10, 64); err == nil {
		return seed, nil
	}
	return 0, fmt.Errorf("invalid key format: %s", key)
}
