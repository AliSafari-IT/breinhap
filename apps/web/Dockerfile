FROM node:24-alpine AS build
WORKDIR /apps
COPY site/src/theme.css site/src/theme.css
COPY site/public/logo.svg site/public/favicon.svg site/public/theme.js site/public/
COPY web/src web/src
RUN node web/src/build.mjs

FROM nginxinc/nginx-unprivileged:1.29-alpine
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /apps/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
