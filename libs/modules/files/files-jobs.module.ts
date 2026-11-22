import { Module } from '@nestjs/common';
import { JobsModule } from '@teachhub/infra';
import { PurgePendingFilesJob } from './application/purge-pending-files.job.js';

/** Phần không có controller của module files cho `worker` dùng (job `files.purge-pending`). */
@Module({
  imports: [JobsModule],
  providers: [PurgePendingFilesJob],
  exports: [PurgePendingFilesJob],
})
export class FilesJobsModule {}
