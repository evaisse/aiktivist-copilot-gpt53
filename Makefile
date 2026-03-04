.PHONY: install dev start migrate test check

install:
	bun install

dev:
	bun run dev

start:
	bun run start

migrate:
	bun run migrate

test:
	bun test

check:
	bun run check
