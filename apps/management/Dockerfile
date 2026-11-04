FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /apps
COPY management/package.json management/package-lock.json management/
RUN cd management && npm ci --omit=dev --ignore-scripts
COPY --chown=node:node management/src management/src
COPY --chown=node:node management/platform.app.json management/platform.app.json
COPY --chown=node:node site/src/theme.css site/src/theme.css
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s \
  CMD node -e "require('node:http').get('http://127.0.0.1:8080/readyz',{headers:{Host:'management.breinhap.com'}},r=>{r.resume();process.exitCode=r.statusCode===200?0:1}).on('error',()=>process.exit(1))"
CMD ["node", "management/src/server.mjs"]
