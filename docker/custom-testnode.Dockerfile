ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ARG BASE_IMAGE
LABEL io.arbitrum.testnode.bundle.parent="${BASE_IMAGE}"

USER root
RUN rm -rf \
	/opt/arbitrum-testnode/export-config \
	/opt/arbitrum-testnode/runtime \
	/opt/arbitrum-testnode/runtime-config
COPY --chown=user:user .testnode-context/export-config /opt/arbitrum-testnode/export-config
COPY .testnode-context/metadata.json /opt/arbitrum-testnode/metadata.json
COPY --chown=user:user .testnode-context/runtime /opt/arbitrum-testnode/runtime
COPY --chown=user:user .testnode-context/runtime-config /opt/arbitrum-testnode/runtime-config
USER user
