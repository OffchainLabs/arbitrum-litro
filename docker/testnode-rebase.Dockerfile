# Rebase an existing testnode image onto a different Nitro image.
#
# `docker/testnode.Dockerfile` builds the published testnode image as
# `FROM ${NITRO_IMAGE}` plus a fixed set of testnode artifacts (anvil, the
# token-bridge workspace, the entrypoint scripts, and the baked snapshot under
# /opt/arbitrum-testnode). Because Nitro is the *base* layer, those artifacts can
# be grafted onto a different Nitro image to boot the same snapshot against a
# Nitro build the caller supplies -- e.g. the image a Nitro PR just built.
#
# Only the paths that `testnode.Dockerfile` adds are copied; everything else
# comes from NITRO_IMAGE. The Nitro base must provide /usr/local/bin/nitro, a
# `user` account, python3, jq, and curl -- the HEALTHCHECK below runs curl --
# (the offchainlabs/nitro-node images provide all of these).
#
# The build context is unused -- every COPY reads from TESTNODE_IMAGE.

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
