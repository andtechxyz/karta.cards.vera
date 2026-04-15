import { Router } from 'express';
import stripeRouter from './stripe.routes.js';

const webhooksRouter: Router = Router();
webhooksRouter.use(stripeRouter);
export default webhooksRouter;
