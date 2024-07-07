FROM oven/bun:1

WORKDIR /app
COPY . /app

RUN bun install

ENTRYPOINT [ "bun", "start" ]