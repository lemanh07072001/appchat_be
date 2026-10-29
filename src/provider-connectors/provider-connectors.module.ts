import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { ConnectorVersion, ConnectorVersionSchema } from './connector-version.schema';
import { ConnectorCache } from './connector-cache.service';
import { ProviderConnectorsService } from './provider-connectors.service';
import { ProviderConnectorsController } from './provider-connectors.controller';
import { ConnectorAccount, ConnectorAccountSchema } from './connector-account.schema';
import { ConnectorAccountsService } from './connector-accounts.service';
import { ConnectorAccountsController } from './connector-accounts.controller';
import { ConnectorSecrets } from './connector-secrets.service';
import { ConnectorHttp } from './connector-http.service';
import { ConnectorCheckLock } from './connector-check-lock.service';
import { ConnectorImport } from './connector-import.service';
import { PersistedWorkflowRun, PersistedWorkflowRunSchema } from './workflow-run.schema';
import { MongoWorkflowStore } from './mongo-workflow.store';
import { ConnectorWorkflowsService } from './connector-workflows.service';
import { ConnectorWorkflowsController } from './connector-workflows.controller';
import { ConnectorRuntime } from './connector-runtime.service';
import { ConnectorDispatch, ConnectorDispatchSchema } from './connector-dispatch.schema';
import { ConnectorDispatches } from './connector-dispatch.service';
import { ConnectorOrderPurchase } from './connector-order-purchase.service';
import { Order, OrderSchema } from '../schemas/orders.schema';
import { Proxy, ProxySchema } from '../schemas/proxies.schema';
import { ConnectorOrderDelivery } from './connector-order-delivery.service';
import { ConnectorServiceBinding } from './connector-service-binding.service';
import { Service, ServiceSchema } from '../schemas/services.schema';
import { ConnectorCheckout } from './connector-checkout.service';
import { User, UserSchema } from '../schemas/users.schema';
import { WalletTransaction, WalletTransactionSchema } from '../schemas/wallet-transaction.schema';
import { Partner, PartnerSchema } from '../schemas/partners.schema';
import { ConnectorMigrationPreview } from './connector-migration-preview.service';
import { ConnectorMigrationController } from './connector-migration.controller';
import { ConnectorAccountReadiness } from './connector-account-readiness.service';
import { ConnectorCredentialMigration } from './connector-credential-migration.service';

@Module({
  imports: [JwtModule, MongooseModule.forFeature([{ name: ConnectorVersion.name, schema: ConnectorVersionSchema },
    { name: ConnectorAccount.name, schema: ConnectorAccountSchema },
    { name: Order.name, schema: OrderSchema },
    { name: Proxy.name, schema: ProxySchema },
    { name: Service.name, schema: ServiceSchema },
    { name: Partner.name, schema: PartnerSchema },
    { name: User.name, schema: UserSchema },
    { name: WalletTransaction.name, schema: WalletTransactionSchema },
    { name: PersistedWorkflowRun.name, schema: PersistedWorkflowRunSchema },
    { name: ConnectorDispatch.name, schema: ConnectorDispatchSchema }])],
  providers: [ConnectorCredentialMigration, ConnectorCache, ProviderConnectorsService, ConnectorSecrets, ConnectorHttp, ConnectorAccountsService, ConnectorCheckLock, ConnectorImport, MongoWorkflowStore, ConnectorWorkflowsService, ConnectorRuntime, ConnectorDispatches, ConnectorOrderPurchase, ConnectorOrderDelivery, ConnectorServiceBinding, ConnectorCheckout, ConnectorMigrationPreview, ConnectorAccountReadiness],
  controllers: [ConnectorMigrationController, ProviderConnectorsController, ConnectorAccountsController, ConnectorWorkflowsController],
  exports: [ProviderConnectorsService, ConnectorWorkflowsService, ConnectorRuntime, ConnectorDispatches, ConnectorOrderPurchase, ConnectorOrderDelivery, ConnectorServiceBinding, ConnectorCheckout],
})
export class ProviderConnectorsModule {}
