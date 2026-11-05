FROM node:22-bookworm-slim AS smartexit-build
WORKDIR /workspace/smartexit
COPY smartexit/ ./
RUN npm ci && npm run build --workspace @smartexit/web

FROM php:8.4-apache
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libcurl4-openssl-dev libpq-dev \
    && docker-php-ext-install curl pdo_pgsql pdo_mysql pdo_sqlite \
    && a2enmod headers rewrite \
    && rm -rf /var/lib/apt/lists/*

COPY deploy/apache-ethcryptohub.conf /etc/apache2/conf-available/ethcryptohub.conf
COPY deploy/production.ini /usr/local/etc/php/conf.d/production.ini
RUN a2enconf ethcryptohub
COPY . /var/www/html/
COPY --from=smartexit-build /workspace/smartexit/apps/web/dist /var/www/html/smartexit/apps/web/dist
COPY deploy/apache-entrypoint.sh /usr/local/bin/apache-entrypoint
RUN chmod +x /usr/local/bin/apache-entrypoint \
    && chown -R www-data:www-data /var/www/html/smartexit/apps/web/dist

EXPOSE 8080
ENTRYPOINT ["apache-entrypoint"]
