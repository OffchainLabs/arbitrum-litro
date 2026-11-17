ARG SRC
FROM ${SRC}
COPY --chmod=755 arbitrum-testnode /usr/local/bin/arbitrum-testnode
