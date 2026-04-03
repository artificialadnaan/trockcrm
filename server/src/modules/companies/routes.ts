import { Router } from "express";
import {
  listCompanies,
  getCompanyById,
  createCompany,
  updateCompany,
  getCompanyContacts,
  getCompanyDeals,
  getCompanyStats,
  searchCompanies,
} from "./service.js";
import { AppError } from "../../middleware/error-handler.js";

const router = Router();

// GET /companies/search?q=greystar — autocomplete for dropdowns
router.get("/search", async (req, res, next) => {
  try {
    const q = (req.query.q as string) || "";
    const results = await searchCompanies(req.tenantDb!, q);
    await req.commitTransaction!();
    res.json({ companies: results });
  } catch (err) { next(err); }
});

// GET /companies — list with search, filter, pagination
router.get("/", async (req, res, next) => {
  try {
    const { search, category, page, limit } = req.query as Record<string, string>;
    const result = await listCompanies(req.tenantDb!, {
      search,
      category,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 50,
    });
    await req.commitTransaction!();
    res.json(result);
  } catch (err) { next(err); }
});

// GET /companies/:id
router.get("/:id", async (req, res, next) => {
  try {
    const company = await getCompanyById(req.tenantDb!, req.params.id);
    if (!company) throw new AppError(404, "Company not found");
    const stats = await getCompanyStats(req.tenantDb!, req.params.id);
    await req.commitTransaction!();
    res.json({ company: { ...company, ...stats } });
  } catch (err) { next(err); }
});

// POST /companies
router.post("/", async (req, res, next) => {
  try {
    const { name, category, address, city, state, zip, phone, website, notes } = req.body;
    if (!name) throw new AppError(400, "Company name is required");
    const company = await createCompany(req.tenantDb!, {
      name, category: category || "other", address, city, state, zip, phone, website, notes,
    });
    await req.commitTransaction!();
    res.status(201).json({ company });
  } catch (err) { next(err); }
});

// PATCH /companies/:id
router.patch("/:id", async (req, res, next) => {
  try {
    const company = await updateCompany(req.tenantDb!, req.params.id, req.body);
    if (!company) throw new AppError(404, "Company not found");
    await req.commitTransaction!();
    res.json({ company });
  } catch (err) { next(err); }
});

// GET /companies/:id/contacts
router.get("/:id/contacts", async (req, res, next) => {
  try {
    const list = await getCompanyContacts(req.tenantDb!, req.params.id);
    await req.commitTransaction!();
    res.json({ contacts: list });
  } catch (err) { next(err); }
});

// GET /companies/:id/deals
router.get("/:id/deals", async (req, res, next) => {
  try {
    const list = await getCompanyDeals(req.tenantDb!, req.params.id);
    await req.commitTransaction!();
    res.json({ deals: list });
  } catch (err) { next(err); }
});

export const companyRoutes = router;
