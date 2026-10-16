# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM golang:1.27-alpine AS build
ARG TARGETOS TARGETARCH VERSION=dev
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/besigor-agent ./cmd/besigor-agent

# Runs as root: reading the host's /proc/1/mountinfo and docker.sock needs it.
FROM gcr.io/distroless/static-debian12
COPY --from=build /out/besigor-agent /besigor-agent
ENV HOST_ROOT=/host
ENTRYPOINT ["/besigor-agent"]
