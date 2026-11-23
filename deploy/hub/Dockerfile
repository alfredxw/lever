# The build script supplies a statically linked Linux binary for this platform.
FROM scratch
COPY lever-hub /lever-hub
COPY ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --chown=65532:65532 data /var/lib/lever-hub
COPY --chown=65532:65532 tmp /tmp
USER 65532:65532
ENV LEVER_HUB_DATA_DIR=/var/lib/lever-hub
EXPOSE 8090 443
ENTRYPOINT ["/lever-hub"]
