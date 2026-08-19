# Rebase an existing testnode image onto a different Nitro image.
#
# `testnode.Dockerfile` builds the published image as `FROM ${NITRO_IMAGE}` plus a
# fixed set of testnode artifacts. Because Nitro is the *base* layer, those
# artifacts graft onto a different Nitro image -- letting the same snapshot boot
# against a Nitro build the caller supplies. Only those paths are copied;
# everything else comes from NITRO_IMAGE.
#
# NITRO_IMAGE must provide /usr/local/bin/nitro, a `user` account, python3, jq,
# and curl (the offchainlabs/nitro-node images do).

ARG TESTNODE_IMAGE
ARG NITRO_IMAGE

FROM ${TESTNODE_IMAGE} AS testnode

FROM ${NITRO_IMAGE}

USER root

COPY --from=testnode /usr/local/bin/anvil /usr/local/bin/anvil
COPY --from=testnode /usr/local/bin/node /usr/local/bin/node
COPY --from=testnode /usr/local/bin/arbitrum-testnode /usr/local/bin/arbitrum-testnode
COPY --from=testnode /usr/local/bin/config-server.py /usr/local/bin/config-server.py
COPY --from=testnode /usr/local/bin/healthcheck.sh /usr/local/bin/healthcheck.sh
COPY --from=testnode /usr/local/bin/configure-parent-chain-poll-interval.mjs /usr/local/bin/configure-parent-chain-poll-interval.mjs
COPY --from=testnode /opt/yarn-v1.22.22 /opt/yarn-v1.22.22
COPY --from=testnode --chown=user:user /workspace /workspace
COPY --from=testnode --chown=user:user /opt/arbitrum-testnode /opt/arbitrum-testnode

# The copied node binary needs libstdc++6. Debian-based Nitro images already
# carry it, so only reach for the network when it is genuinely missing.
RUN if ! ldconfig -p | grep -q 'libstdc++\.so\.6'; then \
	apt-get update \
	&& apt-get install -y --no-install-recommends libstdc++6 \
	&& rm -rf /var/lib/apt/lists/*; \
	fi

RUN ln -sf /opt/yarn-v1.22.22/bin/yarn /usr/local/bin/yarn
RUN mkdir -p /tokenbridge-data && chown user:user /tokenbridge-data

USER user
WORKDIR /home/user

# Marks rebase outputs so hosts can garbage-collect them by label, e.g.:
#   docker image prune -af --filter "label=org.offchainlabs.testnode-rebase=true" --filter "until=168h"
LABEL org.offchainlabs.testnode-rebase=true

EXPOSE 8545 8547 8548 8549 8550 8080

HEALTHCHECK --interval=3s --timeout=3s --start-period=30s --retries=10 \
	CMD /usr/local/bin/healthcheck.sh

ENTRYPOINT ["/usr/local/bin/arbitrum-testnode"]
