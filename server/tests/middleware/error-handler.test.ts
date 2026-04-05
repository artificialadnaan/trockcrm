import { describe, it, expect, vi, afterEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { AppError, errorHandler } from "../../src/middleware/error-handler.js";

function mockResponse() {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as Response;

  vi.mocked(res.status).mockReturnValue(res);
  return res;
}

describe("errorHandler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not log expected client auth failures as server errors", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = mockResponse();

    errorHandler(
      new AppError(401, "Authentication required"),
      {} as Request,
      res,
      vi.fn() as NextFunction,
    );

    expect(errorSpy).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: { message: "Authentication required", code: undefined },
    });
  });

  it("logs unexpected server failures", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = mockResponse();
    const err = new Error("boom");

    errorHandler(err, {} as Request, res, vi.fn() as NextFunction);

    expect(errorSpy).toHaveBeenCalledOnce();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: { message: "Internal server error" },
    });
  });
});
