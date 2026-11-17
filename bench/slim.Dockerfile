ARG SRC
FROM ${SRC} AS src

FROM debian:bookworm-slim
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl jq python3 libatomic1 libstdc++6 \
	&& rm -rf /var/lib/apt/lists/* \
	&& useradd -s /bin/bash user \
	&& mkdir -p /tokenbridge-data && chown user:user /tokenbridge-data
COPY --from=src /usr/local/bin/nitro /usr/local/bin/anvil /usr/local/bin/node /usr/local/bin/arbitrum-testnode /usr/local/bin/configure-parent-chain-poll-interval.mjs /usr/local/bin/healthcheck.sh /usr/local/bin/config-server.py /usr/local/bin/
COPY --from=src --chown=user:user /home/user /home/user
COPY --from=src --chown=user:user /opt/arbitrum-testnode /opt/arbitrum-testnode
RUN nitro --version && node --version && anvil --version
USER user
WORKDIR /home/user
EXPOSE 8545 8547 8548 8549 8550 8080 9642 9646
HEALTHCHECK --interval=3s --timeout=3s --start-period=30s --retries=10 \
	CMD /usr/local/bin/healthcheck.sh
ENTRYPOINT ["/usr/local/bin/arbitrum-testnode"]
