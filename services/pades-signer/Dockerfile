# ==============================================================================
# Microsserviço Opcional de Assinatura PAdES / Apache PDFBox
# ==============================================================================
# Este Dockerfile empacota um serviço auxiliar em Java 21 com Apache PDFBox e BouncyCastle.
# Por padrão, o prontuário utiliza a engine nativa Node.js/TypeScript (pdf-lib + pkijs)
# que não exige containers adicionais nem latência entre processos.
# Utilize este container caso sua infraestrutura exija estritamente a pilha Java/PDFBox.
# ==============================================================================

FROM eclipse-temurin:21-jre-alpine

WORKDIR /app

# Usuário sem privilégios para segurança
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY --chown=appuser:appgroup target/pades-signer-service.jar app.jar 2>/dev/null || true

USER appuser

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q --spider http://localhost:8080/health || exit 1

ENTRYPOINT ["java", "-XX:+UseG1GC", "-XX:MaxRAMPercentage=75.0", "-jar", "app.jar"]
