FROM golang:1.23.12-alpine3.21 AS builder

WORKDIR /src

RUN apk add --no-cache ca-certificates

COPY go.mod go.sum ./
RUN go mod download

COPY . .

ARG VERSION=dev
RUN CGO_ENABLED=0 GOOS=linux go build \
    -trimpath \
    -ldflags="-s -w -X main.Version=${VERSION}" \
    -o /out/liveuser \
    .

FROM alpine:3.21.6

RUN apk add --no-cache ca-certificates tzdata wget \
    && addgroup -S liveuser \
    && adduser -S -G liveuser liveuser

WORKDIR /app
COPY --from=builder /out/liveuser /app/liveuser

USER liveuser

EXPOSE 10086

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:10086/ || exit 1

ENTRYPOINT ["/app/liveuser"]
